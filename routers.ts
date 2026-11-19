// ── AGENT-OWNED: tRPC API surface ────────────────────────────────────────────
// Thin procedures: validate with zod, call server/db.ts, map failures to
// TRPCErrors the user can act on. Auth comes from _core — never reimplemented.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "./_core/trpc";
import { authProvider, registerLocalUser, AuthError, EmailTakenError } from "./_core/auth";
import { storageCommit, storageDeleteOwned, storageListByOwner, storagePutUrl, StorageError } from "./_core/storage";
import { isUniqueViolation } from "./_core/db";
import * as q from "./db";
import { ORDER_STATUSES, SORT_OPTIONS } from "../shared/shop";
import { isStaff } from "../shared/constants";
import { createRazorpayOrder, razorpayConfigured, razorpayPublicKey, verifyRazorpaySignature } from "./services/razorpay";

// ── Role middleware ──────────────────────────────────────────────────────────
// `adminProcedure` from _core only knows role === "admin". ShopSphere needs a
// second tier: staff may manage catalogue and orders but not customers/roles.
// Both are enforced SERVER-SIDE — hiding a nav link is not access control.
const staffProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!isStaff(ctx.user.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Staff access required." });
  }
  return next({ ctx });
});

const ownerOnlyProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can do that." });
  }
  return next({ ctx });
});

// ── Auth ────────────────────────────────────────────────────────────────────
const authRouter = router({
  me: publicProcedure.query(({ ctx }) => ctx.user),

  signup: publicProcedure
    .input(z.object({ email: z.email(), password: z.string().min(8), name: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const user = await registerLocalUser(input.email, input.password, input.name);
        await authProvider().login(ctx.c, input.email, input.password);
        return user;
      } catch (e: unknown) {
        if (e instanceof EmailTakenError) throw new TRPCError({ code: "CONFLICT", message: e.message });
        throw e;
      }
    }),

  login: publicProcedure
    .input(z.object({ email: z.email(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await authProvider().login(ctx.c, input.email, input.password);
      } catch (e) {
        if (e instanceof AuthError) throw new TRPCError({ code: "UNAUTHORIZED", message: e.message });
        throw e;
      }
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    await authProvider().logout(ctx.c);
    return { ok: true };
  }),
});

// ── Catalogue (public) ──────────────────────────────────────────────────────
const sortEnum = z.enum(SORT_OPTIONS.map((o) => o.value) as [string, ...string[]]);

const catalogRouter = router({
  categories: publicProcedure
    .input(z.object({ activeOnly: z.boolean().optional() }).optional())
    .query(({ input }) => q.listCategories({ activeOnly: input?.activeOnly ?? true })),

  category: publicProcedure
    .input(z.object({ slug: z.string() }))
    .query(async ({ input }) => {
      const row = await q.getCategoryBySlug(input.slug);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Category not found." });
      return row;
    }),

  products: publicProcedure
    .input(
      z.object({
        search: z.string().optional(),
        categoryId: z.uuid().optional(),
        brands: z.array(z.string()).optional(),
        minPrice: z.number().int().nonnegative().optional(),
        maxPrice: z.number().int().nonnegative().optional(),
        minRating: z.number().min(0).max(5).optional(),
        inStockOnly: z.boolean().optional(),
        featuredOnly: z.boolean().optional(),
        sort: sortEnum.optional(),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(60).optional(),
      }),
    )
    .query(({ input }) => q.listProducts({ ...input, sort: input.sort as never })),

  brands: publicProcedure
    .input(z.object({ categoryId: z.uuid().optional(), search: z.string().optional() }).optional())
    .query(({ input }) => q.listBrands({ categoryId: input?.categoryId, search: input?.search })),

  product: publicProcedure
    .input(z.object({ slug: z.string() }))
    .query(async ({ input }) => {
      const product = await q.getProductBySlug(input.slug);
      if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
      const [related, reviews] = await Promise.all([
        q.listRelatedProducts(product.id, product.categoryId, 4),
        q.listReviews(product.id),
      ]);
      return { product, related, reviews };
    }),

  banners: publicProcedure.query(() => q.listBanners({ activeOnly: true })),

  home: publicProcedure.query(async () => {
    const [banners, categories, featured, deals, newest] = await Promise.all([
      q.listBanners({ activeOnly: true }),
      q.listCategories({ activeOnly: true }),
      q.listProducts({ featuredOnly: true, pageSize: 8 }),
      q.listProducts({ sort: "discount", pageSize: 8 }),
      q.listProducts({ sort: "newest", pageSize: 8 }),
    ]);
    return {
      banners,
      categories,
      featured: featured.items,
      deals: deals.items,
      newest: newest.items,
    };
  }),
});

// ── Cart ────────────────────────────────────────────────────────────────────
const cartRouter = router({
  get: protectedProcedure.query(({ ctx }) => q.getCart(ctx.user.id)),

  add: protectedProcedure
    .input(z.object({ productId: z.uuid(), qty: z.number().int().min(1).max(20).default(1) }))
    .mutation(async ({ ctx, input }) => {
      const res = await q.addToCart(ctx.user.id, input.productId, input.qty);
      if (!res.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            res.reason === "out_of_stock"
              ? "That item is out of stock."
              : "That product is no longer available.",
        });
      }
      return res;
    }),

  setQty: protectedProcedure
    .input(z.object({ itemId: z.uuid(), qty: z.number().int().min(0).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const res = await q.setCartQty(ctx.user.id, input.itemId, input.qty);
      if (!res.ok) throw new TRPCError({ code: "NOT_FOUND", message: "That cart item no longer exists." });
      return res;
    }),

  remove: protectedProcedure
    .input(z.object({ itemId: z.uuid() }))
    .mutation(({ ctx, input }) => q.removeCartItem(ctx.user.id, input.itemId)),

  clear: protectedProcedure.mutation(({ ctx }) => q.clearCart(ctx.user.id)),
});

// ── Wishlist ────────────────────────────────────────────────────────────────
const wishlistRouter = router({
  list: protectedProcedure.query(({ ctx }) => q.listWishlist(ctx.user.id)),

  ids: protectedProcedure.query(({ ctx }) => q.wishlistProductIds(ctx.user.id)),

  toggle: protectedProcedure
    .input(z.object({ productId: z.uuid() }))
    .mutation(({ ctx, input }) => q.toggleWishlist(ctx.user.id, input.productId)),

  remove: protectedProcedure
    .input(z.object({ productId: z.uuid() }))
    .mutation(({ ctx, input }) => q.removeWishlistItem(ctx.user.id, input.productId)),
});

// ── Addresses ───────────────────────────────────────────────────────────────
const addressInput = z.object({
  label: z.string().max(40).optional(),
  fullName: z.string().min(2).max(80),
  phone: z.string().min(6).max(20),
  line1: z.string().min(3).max(160),
  line2: z.string().max(160).optional().nullable(),
  city: z.string().min(2).max(60),
  state: z.string().min(2).max(60),
  pincode: z.string().min(4).max(10),
  isDefault: z.boolean().optional(),
});

const addressRouter = router({
  list: protectedProcedure.query(({ ctx }) => q.listAddresses(ctx.user.id)),

  create: protectedProcedure.input(addressInput).mutation(({ ctx, input }) => q.createAddress(ctx.user.id, input)),

  update: protectedProcedure
    .input(addressInput.partial().extend({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const row = await q.updateAddress(ctx.user.id, id, patch);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Address not found." });
      return row;
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => q.deleteAddress(ctx.user.id, input.id)),

  setDefault: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await q.updateAddress(ctx.user.id, input.id, { isDefault: true });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Address not found." });
      return row;
    }),
});

// ── Checkout / orders ───────────────────────────────────────────────────────
const checkoutRouter = router({
  /** Is Razorpay usable right now? Drives the payment-method UI honestly. */
  paymentOptions: publicProcedure.query(async () => ({
    razorpay: await razorpayConfigured(),
    razorpayKeyId: await razorpayPublicKey(),
    cod: true,
  })),

  /** Validates a coupon against the live cart and returns the discount. */
  applyCoupon: protectedProcedure
    .input(z.object({ code: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const cart = await q.getCart(ctx.user.id);
      const coupon = await q.findCoupon(input.code);
      if (!coupon) throw new TRPCError({ code: "NOT_FOUND", message: "That coupon code is not valid." });
      if (cart.subtotal < coupon.minSubtotal) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `This coupon needs a minimum order of ₹${(coupon.minSubtotal / 100).toLocaleString("en-IN")}.`,
        });
      }
      const discount =
        coupon.kind === "pct"
          ? Math.round((cart.subtotal * coupon.value) / 100)
          : Math.min(coupon.value, cart.subtotal);
      return { code: coupon.code, discount, kind: coupon.kind, value: coupon.value };
    }),

  /**
   * Creates a Razorpay order for the current cart total. The amount is computed
   * SERVER-SIDE from the cart — never taken from the client, which could
   * otherwise pay ₹1 for a ₹50,000 order.
   */
  createRazorpayOrder: protectedProcedure
    .input(z.object({ couponCode: z.string().optional().nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (!(await razorpayConfigured())) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET under Web Admin → Secrets.",
        });
      }
      const cart = await q.getCart(ctx.user.id);
      if (cart.items.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Your cart is empty." });

      let discount = 0;
      if (input.couponCode) {
        const coupon = await q.findCoupon(input.couponCode);
        if (coupon && cart.subtotal >= coupon.minSubtotal) {
          discount =
            coupon.kind === "pct"
              ? Math.round((cart.subtotal * coupon.value) / 100)
              : Math.min(coupon.value, cart.subtotal);
        }
      }
      const shipping = cart.subtotal >= 49900 ? 0 : 4900;
      const total = Math.max(0, cart.subtotal - discount + shipping);

      const rzp = await createRazorpayOrder({
        amountPaise: total,
        receipt: `cart-${ctx.user.id.slice(0, 8)}-${Date.now()}`,
        notes: { userId: ctx.user.id },
      });
      return { razorpayOrderId: rzp.id, amount: rzp.amount, currency: rzp.currency, keyId: await razorpayPublicKey() };
    }),

  place: protectedProcedure
    .input(
      z.object({
        addressId: z.uuid(),
        paymentMethod: z.enum(["cod", "razorpay"]),
        couponCode: z.string().optional().nullable(),
        razorpayOrderId: z.string().optional().nullable(),
        razorpayPaymentId: z.string().optional().nullable(),
        razorpaySignature: z.string().optional().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // A Razorpay order must be verified BEFORE the order is written, so a
      // forged callback can never create a "paid" order.
      if (input.paymentMethod === "razorpay") {
        if (!input.razorpayOrderId || !input.razorpayPaymentId || !input.razorpaySignature) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Payment details are incomplete." });
        }
        const valid = await verifyRazorpaySignature({
          razorpayOrderId: input.razorpayOrderId,
          razorpayPaymentId: input.razorpayPaymentId,
          signature: input.razorpaySignature,
        });
        if (!valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Payment could not be verified. You have not been charged — please try again.",
          });
        }
      }

      const res = await q.placeOrder({
        userId: ctx.user.id,
        addressId: input.addressId,
        paymentMethod: input.paymentMethod,
        couponCode: input.couponCode ?? null,
        razorpayOrderId: input.razorpayOrderId ?? null,
      });

      if (!res.ok) {
        const messages: Record<string, string> = {
          empty_cart: "Your cart is empty.",
          bad_address: "That delivery address could not be found.",
          unavailable: "An item in your cart is no longer available.",
          insufficient_stock: "Not enough stock for an item in your cart.",
        };
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            res.reason === "insufficient_stock" && "title" in res
              ? `Only ${"available" in res ? res.available : 0} left of “${res.title}”. Please adjust your cart.`
              : messages[res.reason] ?? "Could not place the order.",
        });
      }

      if (input.paymentMethod === "razorpay" && input.razorpayPaymentId) {
        await q.markOrderPaid(res.orderNo, input.razorpayPaymentId);
      }
      return res;
    }),

  myOrders: protectedProcedure.query(({ ctx }) => q.listOrdersForUser(ctx.user.id)),

  order: protectedProcedure
    .input(z.object({ orderNo: z.string() }))
    .query(async ({ ctx, input }) => {
      const order = await q.getOrderForUser(ctx.user.id, input.orderNo);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
      return order;
    }),

  cancel: protectedProcedure
    .input(z.object({ orderNo: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const res = await q.cancelOrderForUser(ctx.user.id, input.orderNo);
      if (!res.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            res.reason === "not_found"
              ? "Order not found."
              : "This order has already shipped and can no longer be cancelled.",
        });
      }
      return res;
    }),
});

// ── Reviews ─────────────────────────────────────────────────────────────────
const reviewRouter = router({
  create: protectedProcedure
    .input(z.object({ productId: z.uuid(), rating: z.number().int().min(1).max(5), body: z.string().max(1000).optional() }))
    .mutation(({ ctx, input }) => q.createReview(ctx.user.id, input.productId, input.rating, input.body)),
});

// ── Admin: catalogue ────────────────────────────────────────────────────────
const productInput = z.object({
  title: z.string().min(2).max(160),
  slug: z.string().max(90).optional(),
  description: z.string().max(4000).optional().nullable(),
  categoryId: z.uuid(),
  brand: z.string().max(60).optional().nullable(),
  price: z.number().int().positive(),
  mrp: z.number().int().positive(),
  stock: z.number().int().min(0),
  sku: z.string().min(1).max(60),
  imageUrl: z.string().max(500).optional().nullable(),
  gallery: z.array(z.string().max(500)).max(8).optional(),
  isFeatured: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const adminCatalogRouter = router({
  products: staffProcedure
    .input(
      z.object({
        search: z.string().optional(),
        categoryId: z.uuid().optional(),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(60).optional(),
        sort: sortEnum.optional(),
        lowStockOnly: z.boolean().optional(),
      }),
    )
    .query(({ input }) =>
      q.listProducts({
        search: input.search,
        categoryId: input.categoryId,
        page: input.page,
        pageSize: input.pageSize ?? 20,
        sort: input.sort as never,
        includeInactive: true,
      }),
    ),

  product: staffProcedure.input(z.object({ id: z.uuid() })).query(async ({ input }) => {
    const row = await q.getProductById(input.id);
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
    return row;
  }),

  create: staffProcedure.input(productInput).mutation(async ({ input }) => {
    try {
      return await q.createProduct(input);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A product with that SKU or URL slug already exists. Change one and try again.",
        });
      }
      throw e;
    }
  }),

  update: staffProcedure
    .input(productInput.partial().extend({ id: z.uuid() }))
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      try {
        const row = await q.updateProduct(id, patch);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
        return row;
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A product with that SKU or URL slug already exists. Change one and try again.",
          });
        }
        throw e;
      }
    }),

  // Deleting a product is admin-only: staff can edit and deactivate, not destroy.
  remove: ownerOnlyProcedure.input(z.object({ id: z.uuid() })).mutation(({ input }) => q.deleteProduct(input.id)),

  bulk: staffProcedure
    .input(
      z.object({
        ids: z.array(z.uuid()).min(1).max(200),
        op: z.enum([
          "set_price",
          "adjust_price_pct",
          "set_discount",
          "set_stock",
          "adjust_stock",
          "activate",
          "deactivate",
          "feature",
          "unfeature",
        ]),
        value: z.number().optional(),
      }),
    )
    .mutation(({ input }) => q.bulkUpdateProducts(input.ids, input.op, input.value ?? 0)),

  lowStock: staffProcedure
    .input(z.object({ threshold: z.number().int().min(0).max(1000).optional() }).optional())
    .query(({ input }) => q.listLowStock(input?.threshold ?? 10)),
});

// ── Admin: categories ───────────────────────────────────────────────────────
const categoryInput = z.object({
  name: z.string().min(2).max(60),
  slug: z.string().max(60).optional(),
  description: z.string().max(500).optional().nullable(),
  imageUrl: z.string().max(500).optional().nullable(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const adminCategoryRouter = router({
  list: staffProcedure.query(() => q.listCategories({ activeOnly: false })),

  create: staffProcedure.input(categoryInput).mutation(async ({ input }) => {
    try {
      return await q.createCategory(input);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new TRPCError({ code: "CONFLICT", message: "A category with that URL slug already exists." });
      }
      throw e;
    }
  }),

  update: staffProcedure
    .input(categoryInput.partial().extend({ id: z.uuid() }))
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      try {
        const row = await q.updateCategory(id, patch);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Category not found." });
        return row;
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new TRPCError({ code: "CONFLICT", message: "A category with that URL slug already exists." });
        }
        throw e;
      }
    }),

  remove: ownerOnlyProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ input }) => {
    const res = await q.deleteCategory(input.id);
    if (!res.ok) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `This category still holds ${res.productCount} product${res.productCount === 1 ? "" : "s"}. Move or delete them first.`,
      });
    }
    return res;
  }),
});

// ── Admin: banners ──────────────────────────────────────────────────────────
const bannerInput = z.object({
  title: z.string().min(2).max(120),
  subtitle: z.string().max(240).optional().nullable(),
  ctaLabel: z.string().max(40).optional().nullable(),
  ctaHref: z.string().max(200).optional().nullable(),
  imageUrl: z.string().max(500).optional().nullable(),
  bgColor: z.string().max(20).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const adminBannerRouter = router({
  list: staffProcedure.query(() => q.listBanners({ activeOnly: false })),

  create: staffProcedure.input(bannerInput).mutation(({ input }) => q.createBanner(input)),

  update: staffProcedure
    .input(bannerInput.partial().extend({ id: z.uuid() }))
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      const row = await q.updateBanner(id, patch);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Banner not found." });
      return row;
    }),

  remove: ownerOnlyProcedure.input(z.object({ id: z.uuid() })).mutation(({ input }) => q.deleteBanner(input.id)),
});

// ── Admin: orders ───────────────────────────────────────────────────────────
const adminOrderRouter = router({
  list: staffProcedure
    .input(z.object({ status: z.string().optional(), search: z.string().optional() }).optional())
    .query(({ input }) => q.adminListOrders(input ?? {})),

  get: staffProcedure.input(z.object({ orderNo: z.string() })).query(async ({ input }) => {
    const row = await q.adminGetOrder(input.orderNo);
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
    return row;
  }),

  setStatus: staffProcedure
    .input(z.object({ orderNo: z.string(), status: z.enum(ORDER_STATUSES), note: z.string().max(300).optional() }))
    .mutation(async ({ input }) => {
      const res = await q.adminUpdateOrderStatus(input.orderNo, input.status, input.note);
      if (!res.ok) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
      return res;
    }),
});

// ── Admin: customers (admin only) ───────────────────────────────────────────
const adminCustomerRouter = router({
  list: ownerOnlyProcedure
    .input(z.object({ search: z.string().optional() }).optional())
    .query(({ input }) => q.adminListCustomers(input?.search)),

  setRole: ownerOnlyProcedure
    .input(z.object({ userId: z.uuid(), role: z.enum(["user", "staff", "admin"]) }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot change your own role." });
      }
      const row = await q.adminSetUserRole(input.userId, input.role);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
      return row;
    }),
});

// ── Admin: reports ──────────────────────────────────────────────────────────
const adminReportRouter = router({
  dashboard: staffProcedure.query(() => q.adminDashboard()),
  salesByDay: staffProcedure
    .input(z.object({ days: z.number().int().min(7).max(90).optional() }).optional())
    .query(({ input }) => q.salesByDay(input?.days ?? 30)),
  salesByCategory: staffProcedure.query(() => q.salesByCategory()),
  topProducts: staffProcedure.query(() => q.topProducts(8)),
  inventory: staffProcedure.query(() => q.inventoryReport()),
});

// ── Admin: coupons ──────────────────────────────────────────────────────────
const adminCouponRouter = router({
  list: staffProcedure.query(() => q.listCoupons()),

  create: staffProcedure
    .input(
      z.object({
        code: z.string().min(2).max(30),
        kind: z.enum(["pct", "flat"]),
        value: z.number().int().positive(),
        minSubtotal: z.number().int().min(0).optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await q.createCoupon(input);
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new TRPCError({ code: "CONFLICT", message: "That coupon code already exists." });
        }
        throw e;
      }
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.uuid(),
        code: z.string().min(2).max(30).optional(),
        kind: z.enum(["pct", "flat"]).optional(),
        value: z.number().int().positive().optional(),
        minSubtotal: z.number().int().min(0).optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      const row = await q.updateCoupon(id, patch);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Coupon not found." });
      return row;
    }),

  remove: ownerOnlyProcedure.input(z.object({ id: z.uuid() })).mutation(({ input }) => q.deleteCoupon(input.id)),
});

// ── Files (admin image upload) ──────────────────────────────────────────────
// Same three-step protocol as the scaffold's filesRouter: signed PUT URL →
// browser uploads → commit. Owner-scoped so one admin cannot overwrite another's
// object. Only staff may upload, because these images land on the storefront.
export function sanitizeBasename(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? "";
  const dot = last.lastIndexOf(".");
  const rawStem = dot > 0 ? last.slice(0, dot) : last;
  const rawExt = dot > 0 ? last.slice(dot + 1) : "";
  const stem = rawStem.replace(/[^A-Za-z0-9._-]/g, "").replace(/^\.+/, "") || "upload";
  const ext = rawExt.replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
  return ext ? `${stem}.${ext}` : stem;
}

const filesRouter = router({
  uploadUrl: staffProcedure
    .input(z.object({ name: z.string().min(1), contentType: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const key = `${crypto.randomUUID()}-${sanitizeBasename(input.name)}`;
      try {
        const { uploadUrl, publicPath } = await storagePutUrl(key, input.contentType, { ownerId: ctx.user.id });
        return { key, uploadUrl, publicPath };
      } catch (e) {
        if (e instanceof StorageError && e.code === "failed") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "That file type is not accepted. Use PNG, JPEG, WebP, AVIF or GIF.",
          });
        }
        throw e;
      }
    }),

  commit: staffProcedure
    .input(z.object({ key: z.string().min(1), name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await storageCommit(input.key, { ownerId: ctx.user.id, name: input.name });
      } catch (e) {
        if (e instanceof StorageError && e.code === "not_found") {
          throw new TRPCError({ code: "NOT_FOUND", message: "Upload not found — did the upload finish?" });
        }
        if (e instanceof StorageError && e.code === "forbidden") {
          throw new TRPCError({ code: "FORBIDDEN", message: "That file belongs to another user." });
        }
        throw e;
      }
    }),

  list: staffProcedure.query(({ ctx }) => storageListByOwner(ctx.user.id)),

  remove: staffProcedure
    .input(z.object({ key: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await storageDeleteOwned(ctx.user.id, input.key);
      } catch (e) {
        if (e instanceof StorageError && e.code === "forbidden") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Malformed file key." });
        }
        throw e;
      }
    }),
});

export const appRouter = router({
  auth: authRouter,
  catalog: catalogRouter,
  cart: cartRouter,
  wishlist: wishlistRouter,
  addresses: addressRouter,
  checkout: checkoutRouter,
  reviews: reviewRouter,
  files: filesRouter,
  admin: router({
    catalog: adminCatalogRouter,
    categories: adminCategoryRouter,
    banners: adminBannerRouter,
    orders: adminOrderRouter,
    customers: adminCustomerRouter,
    reports: adminReportRouter,
    coupons: adminCouponRouter,
  }),
});

export type AppRouter = typeof appRouter;
