// ── AGENT-OWNED: business data-access ────────────────────────────────────────
// All queries live here; routers stay thin. Money is integer paise.
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { atomic, db } from "./_core/db";
import {
  addresses,
  banners,
  cartItems,
  carts,
  categories,
  coupons,
  orderEvents,
  orderItems,
  orders,
  products,
  reviews,
  users,
  wishlistItems,
} from "../drizzle/schema";
import { discountFromPrices, shippingFor, slugify, TRACKING_STEPS, type OrderStatus, type SortOption } from "../shared/shop";

// ── Categories ───────────────────────────────────────────────────────────────

export async function listCategories(opts: { activeOnly?: boolean } = {}) {
  const where = opts.activeOnly ? eq(categories.isActive, true) : undefined;
  return db.select().from(categories).where(where).orderBy(asc(categories.sortOrder), asc(categories.name));
}

export async function createCategory(input: {
  name: string;
  slug?: string;
  description?: string | null;
  imageUrl?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}) {
  const [row] = await db
    .insert(categories)
    .values({
      name: input.name,
      slug: input.slug?.trim() || slugify(input.name),
      description: input.description ?? null,
      imageUrl: input.imageUrl ?? null,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
    })
    .returning();
  return row;
}

export async function updateCategory(
  id: string,
  patch: Partial<{
    name: string;
    slug: string;
    description: string | null;
    imageUrl: string | null;
    sortOrder: number;
    isActive: boolean;
  }>,
) {
  const [row] = await db.update(categories).set(patch).where(eq(categories.id, id)).returning();
  return row ?? null;
}

export async function deleteCategory(id: string) {
  const [used] = await db.select({ value: count() }).from(products).where(eq(products.categoryId, id));
  if ((used?.value ?? 0) > 0) {
    return { ok: false as const, reason: "has_products" as const, productCount: used.value };
  }
  await db.delete(categories).where(eq(categories.id, id));
  return { ok: true as const };
}

export async function getCategoryBySlug(slug: string) {
  const [row] = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
  return row ?? null;
}

// ── Products ─────────────────────────────────────────────────────────────────

export type ProductFilters = {
  search?: string;
  categoryId?: string;
  brands?: string[];
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  inStockOnly?: boolean;
  featuredOnly?: boolean;
  includeInactive?: boolean;
  sort?: SortOption;
  page?: number;
  pageSize?: number;
};

function productWhere(f: ProductFilters): SQL | undefined {
  const parts: (SQL | undefined)[] = [];
  if (!f.includeInactive) parts.push(eq(products.isActive, true));
  if (f.categoryId) parts.push(eq(products.categoryId, f.categoryId));
  if (f.featuredOnly) parts.push(eq(products.isFeatured, true));
  if (f.search?.trim()) {
    const term = `%${f.search.trim()}%`;
    parts.push(or(ilike(products.title, term), ilike(products.brand, term), ilike(products.description, term)));
  }
  if (f.brands?.length) parts.push(inArray(products.brand, f.brands));
  if (typeof f.minPrice === "number") parts.push(gte(products.price, f.minPrice));
  if (typeof f.maxPrice === "number") parts.push(lte(products.price, f.maxPrice));
  if (typeof f.minRating === "number" && f.minRating > 0) parts.push(gte(products.rating, f.minRating));
  if (f.inStockOnly) parts.push(sql`${products.stock} > 0`);
  const defined = parts.filter((p): p is SQL => Boolean(p));
  return defined.length ? and(...defined) : undefined;
}

function productOrder(sort: SortOption | undefined) {
  switch (sort) {
    case "price_asc":
      return [asc(products.price)];
    case "price_desc":
      return [desc(products.price)];
    case "rating":
      return [desc(products.rating), desc(products.ratingCount)];
    case "newest":
      return [desc(products.createdAt)];
    case "discount":
      return [desc(products.discountPct)];
    default:
      return [desc(products.isFeatured), desc(products.ratingCount), asc(products.title)];
  }
}

export async function listProducts(f: ProductFilters = {}) {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(60, Math.max(1, f.pageSize ?? 12));
  const where = productWhere(f);

  const [rows, totalRow] = await Promise.all([
    db
      .select({ product: products, categoryName: categories.name, categorySlug: categories.slug })
      .from(products)
      .innerJoin(categories, eq(products.categoryId, categories.id))
      .where(where)
      .orderBy(...productOrder(f.sort))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(products).where(where),
  ]);

  return {
    items: rows.map((r) => ({ ...r.product, categoryName: r.categoryName, categorySlug: r.categorySlug })),
    total: totalRow[0]?.value ?? 0,
    page,
    pageSize,
  };
}

/** Distinct brands for the current filter scope — powers the brand facet. */
export async function listBrands(f: ProductFilters = {}) {
  const where = productWhere({ ...f, brands: undefined });
  const rows = await db
    .selectDistinct({ brand: products.brand })
    .from(products)
    .where(where)
    .orderBy(asc(products.brand));
  return rows.map((r) => r.brand).filter((b): b is string => Boolean(b));
}

export async function getProductBySlug(slug: string) {
  const [row] = await db
    .select({ product: products, categoryName: categories.name, categorySlug: categories.slug })
    .from(products)
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .where(eq(products.slug, slug))
    .limit(1);
  if (!row) return null;
  return { ...row.product, categoryName: row.categoryName, categorySlug: row.categorySlug };
}

export async function getProductById(id: string) {
  const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  return row ?? null;
}

export async function listRelatedProducts(productId: string, categoryId: string, limit = 4) {
  return db
    .select()
    .from(products)
    .where(and(eq(products.categoryId, categoryId), eq(products.isActive, true), ne(products.id, productId)))
    .orderBy(desc(products.rating))
    .limit(limit);
}

export type ProductInput = {
  title: string;
  slug?: string;
  description?: string | null;
  categoryId: string;
  brand?: string | null;
  price: number;
  mrp: number;
  stock: number;
  sku: string;
  imageUrl?: string | null;
  gallery?: string[];
  isFeatured?: boolean;
  isActive?: boolean;
};

export async function createProduct(input: ProductInput) {
  const [row] = await db
    .insert(products)
    .values({
      title: input.title,
      slug: input.slug?.trim() || slugify(input.title),
      description: input.description ?? null,
      categoryId: input.categoryId,
      brand: input.brand ?? null,
      price: input.price,
      mrp: input.mrp,
      discountPct: discountFromPrices(input.price, input.mrp),
      stock: input.stock,
      sku: input.sku,
      imageUrl: input.imageUrl ?? null,
      gallery: input.gallery ?? [],
      isFeatured: input.isFeatured ?? false,
      isActive: input.isActive ?? true,
    })
    .returning();
  return row;
}

export async function updateProduct(id: string, patch: Partial<ProductInput>) {
  const set: Record<string, unknown> = { ...patch, updatedAt: new Date() };
  if (patch.slug !== undefined) set.slug = patch.slug.trim() || slugify(patch.title ?? "product");
  // Keep discountPct consistent with price/mrp.
  if (patch.price !== undefined || patch.mrp !== undefined) {
    const current = await getProductById(id);
    if (current) set.discountPct = discountFromPrices(patch.price ?? current.price, patch.mrp ?? current.mrp);
  }
  const [row] = await db.update(products).set(set).where(eq(products.id, id)).returning();
  return row ?? null;
}

export async function deleteProduct(id: string) {
  await db.delete(products).where(eq(products.id, id));
  return { ok: true };
}

export type BulkOp =
  | "set_price"
  | "adjust_price_pct"
  | "set_discount"
  | "set_stock"
  | "adjust_stock"
  | "activate"
  | "deactivate"
  | "feature"
  | "unfeature";

/** Bulk operations. Each is ONE statement, so it is atomic on its own. */
export async function bulkUpdateProducts(ids: string[], op: BulkOp, value = 0) {
  if (ids.length === 0) return { updated: 0 };
  const now = new Date();
  let stmt;

  switch (op) {
    case "set_price": {
      const price = Math.max(1, Math.round(value));
      stmt = db
        .update(products)
        .set({
          price,
          discountPct: sql`case when ${products.mrp} > 0 and ${price} < ${products.mrp} then round(((${products.mrp} - ${price})::numeric / ${products.mrp}) * 100)::int else 0 end`,
          updatedAt: now,
        })
        .where(inArray(products.id, ids));
      break;
    }
    case "adjust_price_pct": {
      const pct = Math.round(value);
      stmt = db
        .update(products)
        .set({
          price: sql`greatest(1, round(${products.price} * (1 + ${pct}::numeric / 100))::int)`,
          updatedAt: now,
        })
        .where(inArray(products.id, ids));
      break;
    }
    case "set_discount": {
      const pct = Math.max(0, Math.min(90, Math.round(value)));
      stmt = db
        .update(products)
        .set({
          discountPct: pct,
          price: sql`greatest(1, round(${products.mrp} * (1 - ${pct}::numeric / 100))::int)`,
          updatedAt: now,
        })
        .where(inArray(products.id, ids));
      break;
    }
    case "set_stock":
      stmt = db
        .update(products)
        .set({ stock: Math.max(0, Math.round(value)), updatedAt: now })
        .where(inArray(products.id, ids));
      break;
    case "adjust_stock":
      stmt = db
        .update(products)
        .set({ stock: sql`greatest(0, ${products.stock} + ${Math.round(value)})`, updatedAt: now })
        .where(inArray(products.id, ids));
      break;
    case "activate":
      stmt = db.update(products).set({ isActive: true, updatedAt: now }).where(inArray(products.id, ids));
      break;
    case "deactivate":
      stmt = db.update(products).set({ isActive: false, updatedAt: now }).where(inArray(products.id, ids));
      break;
    case "feature":
      stmt = db.update(products).set({ isFeatured: true, updatedAt: now }).where(inArray(products.id, ids));
      break;
    case "unfeature":
      stmt = db.update(products).set({ isFeatured: false, updatedAt: now }).where(inArray(products.id, ids));
      break;
  }
  const rows = await stmt.returning({ id: products.id });
  return { updated: rows.length };
}

export async function listLowStock(threshold = 10, limit = 50) {
  return db
    .select()
    .from(products)
    .where(and(eq(products.isActive, true), lte(products.stock, threshold)))
    .orderBy(asc(products.stock))
    .limit(limit);
}

// ── Banners ──────────────────────────────────────────────────────────────────

export async function listBanners(opts: { activeOnly?: boolean } = {}) {
  const where = opts.activeOnly ? eq(banners.isActive, true) : undefined;
  return db.select().from(banners).where(where).orderBy(asc(banners.sortOrder));
}

export async function createBanner(input: {
  title: string;
  subtitle?: string | null;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  imageUrl?: string | null;
  bgColor?: string;
  sortOrder?: number;
  isActive?: boolean;
}) {
  const [row] = await db
    .insert(banners)
    .values({
      title: input.title,
      subtitle: input.subtitle ?? null,
      ctaLabel: input.ctaLabel ?? null,
      ctaHref: input.ctaHref ?? null,
      imageUrl: input.imageUrl ?? null,
      bgColor: input.bgColor ?? "#1B2A6B",
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
    })
    .returning();
  return row;
}

export async function updateBanner(id: string, patch: Record<string, unknown>) {
  const [row] = await db.update(banners).set(patch).where(eq(banners.id, id)).returning();
  return row ?? null;
}

export async function deleteBanner(id: string) {
  await db.delete(banners).where(eq(banners.id, id));
  return { ok: true };
}

// ── Cart ─────────────────────────────────────────────────────────────────────

async function ensureCart(userId: string) {
  const [existing] = await db.select().from(carts).where(eq(carts.userId, userId)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(carts).values({ userId }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db.select().from(carts).where(eq(carts.userId, userId)).limit(1);
  return again;
}

export async function getCart(userId: string) {
  const cart = await ensureCart(userId);
  if (!cart) return { cartId: null as string | null, items: [], subtotal: 0, count: 0 };
  const rows = await db
    .select({ item: cartItems, product: products })
    .from(cartItems)
    .innerJoin(products, eq(cartItems.productId, products.id))
    .where(eq(cartItems.cartId, cart.id))
    .orderBy(asc(cartItems.createdAt));

  const items = rows.map((r) => ({
    id: r.item.id,
    productId: r.product.id,
    qty: r.item.qty,
    title: r.product.title,
    slug: r.product.slug,
    imageUrl: r.product.imageUrl,
    price: r.product.price,
    mrp: r.product.mrp,
    stock: r.product.stock,
    isActive: r.product.isActive,
    lineTotal: r.product.price * r.item.qty,
  }));
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  return { cartId: cart.id, items, subtotal, count: items.reduce((s, i) => s + i.qty, 0) };
}

export async function addToCart(userId: string, productId: string, qty = 1) {
  const cart = await ensureCart(userId);
  if (!cart) throw new Error("could not create cart");
  const product = await getProductById(productId);
  if (!product || !product.isActive) return { ok: false as const, reason: "unavailable" as const };
  if (product.stock <= 0) return { ok: false as const, reason: "out_of_stock" as const };

  const [existing] = await db
    .select()
    .from(cartItems)
    .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.productId, productId)))
    .limit(1);

  const wanted = (existing?.qty ?? 0) + Math.max(1, qty);
  const desired = Math.min(product.stock, wanted);
  if (existing) {
    await db.update(cartItems).set({ qty: desired }).where(eq(cartItems.id, existing.id));
  } else {
    await db.insert(cartItems).values({ cartId: cart.id, productId, qty: desired }).onConflictDoNothing();
  }
  await db.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cart.id));
  return { ok: true as const, qty: desired, capped: desired < wanted };
}

export async function setCartQty(userId: string, itemId: string, qty: number) {
  const cart = await ensureCart(userId);
  if (!cart) return { ok: false as const };
  const [row] = await db
    .select({ item: cartItems, product: products })
    .from(cartItems)
    .innerJoin(products, eq(cartItems.productId, products.id))
    .where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cart.id)))
    .limit(1);
  if (!row) return { ok: false as const, reason: "not_found" as const };
  if (qty <= 0) {
    await db.delete(cartItems).where(eq(cartItems.id, itemId));
    return { ok: true as const, removed: true };
  }
  const capped = Math.min(qty, Math.max(1, row.product.stock));
  await db.update(cartItems).set({ qty: capped }).where(eq(cartItems.id, itemId));
  return { ok: true as const, qty: capped, capped: capped < qty };
}

export async function removeCartItem(userId: string, itemId: string) {
  const cart = await ensureCart(userId);
  if (!cart) return { ok: false as const };
  await db.delete(cartItems).where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cart.id)));
  return { ok: true as const };
}

export async function clearCart(userId: string) {
  const cart = await ensureCart(userId);
  if (!cart) return { ok: true as const };
  await db.delete(cartItems).where(eq(cartItems.cartId, cart.id));
  return { ok: true as const };
}

// ── Wishlist ─────────────────────────────────────────────────────────────────

export async function listWishlist(userId: string) {
  const rows = await db
    .select({ item: wishlistItems, product: products })
    .from(wishlistItems)
    .innerJoin(products, eq(wishlistItems.productId, products.id))
    .where(eq(wishlistItems.userId, userId))
    .orderBy(desc(wishlistItems.createdAt));
  return rows.map((r) => ({ ...r.product, wishlistId: r.item.id }));
}

export async function toggleWishlist(userId: string, productId: string) {
  const [existing] = await db
    .select()
    .from(wishlistItems)
    .where(and(eq(wishlistItems.userId, userId), eq(wishlistItems.productId, productId)))
    .limit(1);
  if (existing) {
    await db.delete(wishlistItems).where(eq(wishlistItems.id, existing.id));
    return { saved: false };
  }
  await db.insert(wishlistItems).values({ userId, productId }).onConflictDoNothing();
  return { saved: true };
}

export async function removeWishlistItem(userId: string, productId: string) {
  await db
    .delete(wishlistItems)
    .where(and(eq(wishlistItems.userId, userId), eq(wishlistItems.productId, productId)));
  return { ok: true };
}

export async function wishlistProductIds(userId: string) {
  const rows = await db
    .select({ productId: wishlistItems.productId })
    .from(wishlistItems)
    .where(eq(wishlistItems.userId, userId));
  return rows.map((r) => r.productId);
}

// ── Addresses ────────────────────────────────────────────────────────────────

export async function listAddresses(userId: string) {
  return db
    .select()
    .from(addresses)
    .where(eq(addresses.userId, userId))
    .orderBy(desc(addresses.isDefault), desc(addresses.createdAt));
}

export async function createAddress(
  userId: string,
  input: {
    label?: string;
    fullName: string;
    phone: string;
    line1: string;
    line2?: string | null;
    city: string;
    state: string;
    pincode: string;
    isDefault?: boolean;
  },
) {
  const existing = await listAddresses(userId);
  const makeDefault = input.isDefault ?? existing.length === 0;
  if (makeDefault) {
    await db.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
  }
  const [row] = await db
    .insert(addresses)
    .values({
      userId,
      label: input.label?.trim() || "Home",
      fullName: input.fullName,
      phone: input.phone,
      line1: input.line1,
      line2: input.line2 ?? null,
      city: input.city,
      state: input.state,
      pincode: input.pincode,
      isDefault: makeDefault,
    })
    .returning();
  return row;
}

export async function updateAddress(userId: string, id: string, patch: Record<string, unknown>) {
  if (patch.isDefault === true) {
    await db.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
  }
  const [row] = await db
    .update(addresses)
    .set(patch)
    .where(and(eq(addresses.id, id), eq(addresses.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteAddress(userId: string, id: string) {
  await db.delete(addresses).where(and(eq(addresses.id, id), eq(addresses.userId, userId)));
  return { ok: true };
}

// ── Coupons ──────────────────────────────────────────────────────────────────

export async function findCoupon(code: string) {
  const [row] = await db
    .select()
    .from(coupons)
    .where(and(eq(coupons.code, code.trim().toUpperCase()), eq(coupons.isActive, true)))
    .limit(1);
  return row ?? null;
}

export async function listCoupons() {
  return db.select().from(coupons).orderBy(desc(coupons.createdAt));
}

export async function createCoupon(input: {
  code: string;
  kind: "pct" | "flat";
  value: number;
  minSubtotal?: number;
  isActive?: boolean;
}) {
  const [row] = await db
    .insert(coupons)
    .values({
      code: input.code.trim().toUpperCase(),
      kind: input.kind,
      value: input.value,
      minSubtotal: input.minSubtotal ?? 0,
      isActive: input.isActive ?? true,
    })
    .returning();
  return row;
}

export async function updateCoupon(id: string, patch: Record<string, unknown>) {
  const [row] = await db.update(coupons).set(patch).where(eq(coupons.id, id)).returning();
  return row ?? null;
}

export async function deleteCoupon(id: string) {
  await db.delete(coupons).where(eq(coupons.id, id));
  return { ok: true };
}

// ── Orders ───────────────────────────────────────────────────────────────────

function newOrderNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SPH-${ymd}-${rand}`;
}

export type PlaceOrderInput = {
  userId: string;
  addressId: string;
  paymentMethod: "cod" | "razorpay";
  couponCode?: string | null;
  razorpayOrderId?: string | null;
};

/**
 * Places an order from the user's cart.
 *
 * Stock is decremented with a guarded UPDATE inside one `atomic` batch. The
 * `products_stock_nonneg` CHECK constraint (added by a data migration) is the
 * backstop: if two shoppers race for the last unit, the second UPDATE violates
 * it and the whole transaction rolls back — no oversold order, no half-written
 * cart.
 */
export async function placeOrder(input: PlaceOrderInput) {
  const cart = await getCart(input.userId);
  if (!cart.cartId || cart.items.length === 0) return { ok: false as const, reason: "empty_cart" as const };

  const [addr] = await db
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, input.addressId), eq(addresses.userId, input.userId)))
    .limit(1);
  if (!addr) return { ok: false as const, reason: "bad_address" as const };

  for (const item of cart.items) {
    if (!item.isActive) return { ok: false as const, reason: "unavailable" as const, title: item.title };
    if (item.stock < item.qty) {
      return { ok: false as const, reason: "insufficient_stock" as const, title: item.title, available: item.stock };
    }
  }

  let discount = 0;
  let couponCode: string | null = null;
  if (input.couponCode) {
    const coupon = await findCoupon(input.couponCode);
    if (coupon && cart.subtotal >= coupon.minSubtotal) {
      discount =
        coupon.kind === "pct"
          ? Math.round((cart.subtotal * coupon.value) / 100)
          : Math.min(coupon.value, cart.subtotal);
      couponCode = coupon.code;
    }
  }

  const shipping = shippingFor(cart.subtotal);
  const total = Math.max(0, cart.subtotal - discount + shipping);
  const orderId = crypto.randomUUID();
  const orderNo = newOrderNo();
  const cartId = cart.cartId;

  const snapshot: Record<string, string> = {
    fullName: addr.fullName,
    phone: addr.phone,
    line1: addr.line1,
    line2: addr.line2 ?? "",
    city: addr.city,
    state: addr.state,
    pincode: addr.pincode,
    label: addr.label,
  };

  try {
    await atomic((d) => [
      d.insert(orders).values({
        id: orderId,
        orderNo,
        userId: input.userId,
        status: "placed",
        subtotal: cart.subtotal,
        discount,
        shipping,
        total,
        couponCode,
        paymentMethod: input.paymentMethod,
        paymentStatus: "pending",
        razorpayOrderId: input.razorpayOrderId ?? null,
        addressSnapshot: snapshot,
      }),
      d.insert(orderItems).values(
        cart.items.map((i) => ({
          orderId,
          productId: i.productId,
          titleSnapshot: i.title,
          imageSnapshot: i.imageUrl,
          unitPrice: i.price,
          qty: i.qty,
        })),
      ),
      d.insert(orderEvents).values({
        orderId,
        status: "placed",
        note:
          input.paymentMethod === "cod"
            ? "Order placed — pay on delivery"
            : "Order placed — awaiting payment confirmation",
      }),
      ...cart.items.map((i) =>
        d
          .update(products)
          .set({ stock: sql`${products.stock} - ${i.qty}`, updatedAt: new Date() })
          .where(eq(products.id, i.productId)),
      ),
      d.delete(cartItems).where(eq(cartItems.cartId, cartId)),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/products_stock_nonneg|check constraint/i.test(msg)) {
      return { ok: false as const, reason: "insufficient_stock" as const, title: "an item in your cart" };
    }
    throw e;
  }

  return { ok: true as const, orderNo, orderId, total };
}

/**
 * Order summary rows for the customer's order list. Shaped for the UI:
 * item count, first few thumbnails, and `createdAt` (the column is `placed_at`).
 */
export async function listOrdersForUser(userId: string) {
  const rows = await db.select().from(orders).where(eq(orders.userId, userId)).orderBy(desc(orders.placedAt));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const items = await db.select().from(orderItems).where(inArray(orderItems.orderId, ids));

  return rows.map((o) => {
    const mine = items.filter((i) => i.orderId === o.id);
    return {
      id: o.id,
      orderNo: o.orderNo,
      status: o.status,
      createdAt: o.placedAt,
      total: o.total,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      itemCount: mine.reduce((n, i) => n + i.qty, 0),
      thumbnails: mine.map((i) => i.imageSnapshot).filter((s): s is string => Boolean(s)).slice(0, 5),
    };
  });
}

/**
 * One order, owner-scoped. Flattens the address snapshot into `shipping*`
 * fields and maps `order_events` to a `timeline` the UI can draw directly.
 */
export async function getOrderForUser(userId: string, orderNo: string) {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.orderNo, orderNo), eq(orders.userId, userId)))
    .limit(1);
  if (!order) return null;

  const [rawItems, events] = await Promise.all([
    db
      .select({ item: orderItems, productSlug: products.slug })
      .from(orderItems)
      .leftJoin(products, eq(orderItems.productId, products.id))
      .where(eq(orderItems.orderId, order.id)),
    db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id)).orderBy(asc(orderEvents.createdAt)),
  ]);

  const addr = (order.addressSnapshot ?? {}) as Record<string, string>;

  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    createdAt: order.placedAt,
    subtotal: order.subtotal,
    discount: order.discount,
    shipping: order.shipping,
    total: order.total,
    couponCode: order.couponCode,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    razorpayPaymentId: order.razorpayPaymentId,
    shippingName: addr.fullName ?? "",
    shippingPhone: addr.phone ?? "",
    shippingLine1: addr.line1 ?? "",
    shippingLine2: addr.line2 ?? "",
    shippingCity: addr.city ?? "",
    shippingState: addr.state ?? "",
    shippingPincode: addr.pincode ?? "",
    items: rawItems.map((r) => ({
      id: r.item.id,
      productId: r.item.productId,
      productSlug: r.productSlug,
      title: r.item.titleSnapshot,
      imageUrl: r.item.imageSnapshot,
      unitPrice: r.item.unitPrice,
      qty: r.item.qty,
    })),
    timeline: events.map((e) => ({ status: e.status, at: e.createdAt, note: e.note })),
  };
}

export async function getOrderByNo(orderNo: string) {
  const [order] = await db.select().from(orders).where(eq(orders.orderNo, orderNo)).limit(1);
  return order ?? null;
}

export async function cancelOrderForUser(userId: string, orderNo: string) {
  const order = await getOrderForUser(userId, orderNo);
  if (!order) return { ok: false as const, reason: "not_found" as const };
  if (order.status !== "placed" && order.status !== "packed") {
    return { ok: false as const, reason: "too_late" as const, status: order.status };
  }
  const items = order.items;
  await atomic((d) => [
    d.update(orders).set({ status: "cancelled", updatedAt: new Date() }).where(eq(orders.id, order.id)),
    d.insert(orderEvents).values({ orderId: order.id, status: "cancelled", note: "Cancelled by customer" }),
    ...items
      .filter((i) => i.productId)
      .map((i) =>
        d
          .update(products)
          .set({ stock: sql`${products.stock} + ${i.qty}`, updatedAt: new Date() })
          .where(eq(products.id, i.productId as string)),
      ),
  ]);
  return { ok: true as const };
}

export async function markOrderPaid(orderNo: string, razorpayPaymentId: string) {
  const order = await getOrderByNo(orderNo);
  if (!order) return { ok: false as const, reason: "not_found" as const };
  await atomic((d) => [
    d
      .update(orders)
      .set({ paymentStatus: "paid", razorpayPaymentId, updatedAt: new Date() })
      .where(eq(orders.id, order.id)),
    d.insert(orderEvents).values({ orderId: order.id, status: order.status, note: "Payment received via Razorpay" }),
  ]);
  return { ok: true as const };
}

// ── Admin: orders ────────────────────────────────────────────────────────────

export async function adminListOrders(opts: { status?: string; search?: string; limit?: number } = {}) {
  const parts: (SQL | undefined)[] = [];
  if (opts.status && opts.status !== "all") parts.push(eq(orders.status, opts.status));
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`;
    parts.push(or(ilike(orders.orderNo, term), ilike(users.email, term), ilike(users.name, term)));
  }
  const defined = parts.filter((p): p is SQL => Boolean(p));
  const rows = await db
    .select({ order: orders, email: users.email, name: users.name })
    .from(orders)
    .innerJoin(users, eq(orders.userId, users.id))
    .where(defined.length ? and(...defined) : undefined)
    .orderBy(desc(orders.placedAt))
    .limit(Math.min(200, opts.limit ?? 100));
  return rows.map((r) => ({ ...r.order, customerEmail: r.email, customerName: r.name }));
}

export async function adminGetOrder(orderNo: string) {
  const [row] = await db
    .select({ order: orders, email: users.email, name: users.name })
    .from(orders)
    .innerJoin(users, eq(orders.userId, users.id))
    .where(eq(orders.orderNo, orderNo))
    .limit(1);
  if (!row) return null;
  const [items, events] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, row.order.id)),
    db.select().from(orderEvents).where(eq(orderEvents.orderId, row.order.id)).orderBy(asc(orderEvents.createdAt)),
  ]);
  return { ...row.order, customerEmail: row.email, customerName: row.name, items, events };
}

export async function adminUpdateOrderStatus(orderNo: string, status: OrderStatus, note?: string) {
  const order = await getOrderByNo(orderNo);
  if (!order) return { ok: false as const, reason: "not_found" as const };
  if (order.status === status) return { ok: true as const, unchanged: true };

  const restoring = status === "cancelled" && order.status !== "cancelled";
  const items = restoring ? await db.select().from(orderItems).where(eq(orderItems.orderId, order.id)) : [];

  // An admin can jump straight from "placed" to "shipped". Record the stages
  // that were skipped so the customer's timeline never shows a later step
  // complete while an earlier one still reads "Not yet".
  const from = TRACKING_STEPS.indexOf(order.status as OrderStatus);
  const to = TRACKING_STEPS.indexOf(status);
  const skipped =
    from >= 0 && to > from + 1
      ? TRACKING_STEPS.slice(from + 1, to).map((s) => ({ orderId: order.id, status: s, note: null as string | null }))
      : [];

  await atomic((d) => [
    d.update(orders).set({ status, updatedAt: new Date() }).where(eq(orders.id, order.id)),
    ...(skipped.length ? [d.insert(orderEvents).values(skipped)] : []),
    d.insert(orderEvents).values({ orderId: order.id, status, note: note ?? null }),
    ...items
      .filter((i) => i.productId)
      .map((i) =>
        d
          .update(products)
          .set({ stock: sql`${products.stock} + ${i.qty}`, updatedAt: new Date() })
          .where(eq(products.id, i.productId as string)),
      ),
  ]);
  return { ok: true as const };
}

// ── Admin: customers ─────────────────────────────────────────────────────────

export async function adminListCustomers(search?: string) {
  const term = search?.trim() ? `%${search.trim()}%` : null;
  return db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      createdAt: users.createdAt,
      orderCount: sql<number>`count(${orders.id})::int`,
      lifetimeValue: sql<number>`coalesce(sum(case when ${orders.status} <> 'cancelled' then ${orders.total} else 0 end), 0)::int`,
      lastOrderAt: sql<string | null>`max(${orders.placedAt})`,
    })
    .from(users)
    .leftJoin(orders, eq(orders.userId, users.id))
    .where(term ? or(ilike(users.email, term), ilike(users.name, term)) : undefined)
    .groupBy(users.id, users.email, users.name, users.role, users.createdAt)
    .orderBy(desc(sql`coalesce(sum(case when ${orders.status} <> 'cancelled' then ${orders.total} else 0 end), 0)`))
    .limit(200);
}

export async function adminSetUserRole(userId: string, role: "user" | "staff" | "admin") {
  const [row] = await db.update(users).set({ role }).where(eq(users.id, userId)).returning({
    id: users.id,
    email: users.email,
    role: users.role,
  });
  return row ?? null;
}

// ── Admin: reports ───────────────────────────────────────────────────────────

export async function adminDashboard() {
  const [totals] = await db
    .select({
      orderCount: sql<number>`count(*)::int`,
      revenue: sql<number>`coalesce(sum(case when ${orders.status} <> 'cancelled' then ${orders.total} else 0 end), 0)::int`,
      paidRevenue: sql<number>`coalesce(sum(case when ${orders.paymentStatus} = 'paid' then ${orders.total} else 0 end), 0)::int`,
      pending: sql<number>`count(case when ${orders.status} in ('placed','packed','shipped','out_for_delivery') then 1 end)::int`,
    })
    .from(orders);

  const [productStats] = await db
    .select({
      productCount: sql<number>`count(*)::int`,
      activeCount: sql<number>`count(case when ${products.isActive} then 1 end)::int`,
      outOfStock: sql<number>`count(case when ${products.stock} = 0 then 1 end)::int`,
      lowStock: sql<number>`count(case when ${products.stock} > 0 and ${products.stock} <= 10 then 1 end)::int`,
      inventoryValue: sql<number>`coalesce(sum(${products.stock} * ${products.price}), 0)::bigint`,
    })
    .from(products);

  const [customerStats] = await db
    .select({ customerCount: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.role, "user"));

  const orderCount = totals?.orderCount ?? 0;
  const revenue = Number(totals?.revenue ?? 0);

  return {
    orderCount,
    revenue,
    paidRevenue: Number(totals?.paidRevenue ?? 0),
    pendingOrders: totals?.pending ?? 0,
    aov: orderCount > 0 ? Math.round(revenue / orderCount) : 0,
    productCount: productStats?.productCount ?? 0,
    activeProducts: productStats?.activeCount ?? 0,
    outOfStock: productStats?.outOfStock ?? 0,
    lowStock: productStats?.lowStock ?? 0,
    inventoryValue: Number(productStats?.inventoryValue ?? 0),
    customerCount: customerStats?.customerCount ?? 0,
  };
}

export async function salesByDay(days = 30) {
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${orders.placedAt}), 'YYYY-MM-DD')`,
      revenue: sql<number>`coalesce(sum(case when ${orders.status} <> 'cancelled' then ${orders.total} else 0 end), 0)::int`,
      orderCount: sql<number>`count(*)::int`,
    })
    .from(orders)
    .where(sql`${orders.placedAt} >= now() - (${days} || ' days')::interval`)
    .groupBy(sql`date_trunc('day', ${orders.placedAt})`)
    .orderBy(sql`date_trunc('day', ${orders.placedAt})`);

  // Fill gaps so the chart has a continuous axis.
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: { day: string; revenue: number; orderCount: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const hit = byDay.get(key);
    out.push({ day: key, revenue: hit?.revenue ?? 0, orderCount: hit?.orderCount ?? 0 });
  }
  return out;
}

export async function salesByCategory() {
  return db
    .select({
      categoryId: categories.id,
      categoryName: categories.name,
      units: sql<number>`coalesce(sum(${orderItems.qty}), 0)::int`,
      revenue: sql<number>`coalesce(sum(${orderItems.unitPrice} * ${orderItems.qty}), 0)::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(products, eq(orderItems.productId, products.id))
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .where(ne(orders.status, "cancelled"))
    .groupBy(categories.id, categories.name)
    .orderBy(desc(sql`coalesce(sum(${orderItems.unitPrice} * ${orderItems.qty}), 0)`));
}

export async function topProducts(limit = 8) {
  return db
    .select({
      productId: orderItems.productId,
      title: orderItems.titleSnapshot,
      units: sql<number>`coalesce(sum(${orderItems.qty}), 0)::int`,
      revenue: sql<number>`coalesce(sum(${orderItems.unitPrice} * ${orderItems.qty}), 0)::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(ne(orders.status, "cancelled"))
    .groupBy(orderItems.productId, orderItems.titleSnapshot)
    .orderBy(desc(sql`coalesce(sum(${orderItems.unitPrice} * ${orderItems.qty}), 0)`))
    .limit(limit);
}

export async function inventoryReport() {
  return db
    .select({
      id: products.id,
      title: products.title,
      sku: products.sku,
      stock: products.stock,
      price: products.price,
      mrp: products.mrp,
      isActive: products.isActive,
      categoryName: categories.name,
      value: sql<number>`(${products.stock} * ${products.price})::int`,
    })
    .from(products)
    .innerJoin(categories, eq(products.categoryId, categories.id))
    .orderBy(asc(products.stock));
}

// ── Reviews ──────────────────────────────────────────────────────────────────

export async function listReviews(productId: string) {
  const rows = await db
    .select({
      id: reviews.id,
      rating: reviews.rating,
      body: reviews.body,
      createdAt: reviews.createdAt,
      authorName: users.name,
      authorEmail: users.email,
    })
    .from(reviews)
    .innerJoin(users, eq(reviews.userId, users.id))
    .where(eq(reviews.productId, productId))
    .orderBy(desc(reviews.createdAt))
    .limit(50);
  return rows.map((r) => ({
    id: r.id,
    rating: r.rating,
    body: r.body,
    createdAt: r.createdAt,
    // Never expose a full address; a display name is enough.
    authorName: r.authorName?.trim() || r.authorEmail.split("@")[0],
  }));
}

export async function createReview(userId: string, productId: string, rating: number, body?: string) {
  const [row] = await db
    .insert(reviews)
    .values({ userId, productId, rating: Math.max(1, Math.min(5, rating)), body: body ?? null })
    .returning();
  await recomputeRating(productId);
  return row;
}

export async function recomputeRating(productId: string) {
  const [agg] = await db
    .select({
      avg: sql<number>`coalesce(avg(${reviews.rating}), 0)::float`,
      n: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .where(eq(reviews.productId, productId));
  await db
    .update(products)
    .set({ rating: Math.round((agg?.avg ?? 0) * 10) / 10, ratingCount: agg?.n ?? 0 })
    .where(eq(products.id, productId));
}
