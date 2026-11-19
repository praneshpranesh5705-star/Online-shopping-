import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  bigint,
  integer,
  boolean,
  real,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM TABLE — managed by the scaffold. The Agent MUST NOT redefine or drop
// the auth columns here; it only ADDS business tables below.
// ─────────────────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"), // null for SSO-linked users (future)
  name: text("name"),
  role: text("role").notNull().default("user"), // 'user' | 'admin' | 'staff'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// SYSTEM TABLE — managed by the scaffold, written by server/_core/storage.ts.
export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    contentType: text("content_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("files_owner_idx").on(t.ownerId), index("files_created_idx").on(t.createdAt)],
);

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS TABLES — ShopSphere
// Money is stored as INTEGER PAISE everywhere. Formatting happens at the edge.
// ─────────────────────────────────────────────────────────────────────────────

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("categories_slug_idx").on(t.slug), index("categories_sort_idx").on(t.sortOrder)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    brand: text("brand"),
    price: integer("price").notNull(), // paise
    mrp: integer("mrp").notNull(), // paise, list price
    discountPct: integer("discount_pct").notNull().default(0),
    stock: integer("stock").notNull().default(0),
    sku: text("sku").notNull(),
    imageUrl: text("image_url"),
    gallery: jsonb("gallery").$type<string[]>().notNull().default([]),
    rating: real("rating").notNull().default(0),
    ratingCount: integer("rating_count").notNull().default(0),
    isFeatured: boolean("is_featured").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("products_slug_idx").on(t.slug),
    uniqueIndex("products_sku_idx").on(t.sku),
    index("products_category_idx").on(t.categoryId),
    index("products_active_idx").on(t.isActive),
    index("products_featured_idx").on(t.isFeatured),
  ],
);

export const banners = pgTable(
  "banners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    ctaLabel: text("cta_label"),
    ctaHref: text("cta_href"),
    imageUrl: text("image_url"),
    bgColor: text("bg_color").notNull().default("#1B2A6B"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("banners_sort_idx").on(t.sortOrder)],
);

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull().default("Home"),
    fullName: text("full_name").notNull(),
    phone: text("phone").notNull(),
    line1: text("line1").notNull(),
    line2: text("line2"),
    city: text("city").notNull(),
    state: text("state").notNull(),
    pincode: text("pincode").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("addresses_user_idx").on(t.userId)],
);

export const carts = pgTable(
  "carts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("carts_user_idx").on(t.userId)],
);

export const cartItems = pgTable(
  "cart_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    qty: integer("qty").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cart_items_unique_idx").on(t.cartId, t.productId)],
);

export const wishlistItems = pgTable(
  "wishlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("wishlist_unique_idx").on(t.userId, t.productId)],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderNo: text("order_no").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("placed"), // placed|packed|shipped|out_for_delivery|delivered|cancelled
    subtotal: integer("subtotal").notNull(),
    discount: integer("discount").notNull().default(0),
    shipping: integer("shipping").notNull().default(0),
    total: integer("total").notNull(),
    couponCode: text("coupon_code"),
    paymentMethod: text("payment_method").notNull().default("cod"), // cod|razorpay
    paymentStatus: text("payment_status").notNull().default("pending"), // pending|paid|failed|refunded
    razorpayOrderId: text("razorpay_order_id"),
    razorpayPaymentId: text("razorpay_payment_id"),
    addressSnapshot: jsonb("address_snapshot").$type<Record<string, string>>().notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_no_idx").on(t.orderNo),
    index("orders_user_idx").on(t.userId),
    index("orders_status_idx").on(t.status),
    index("orders_placed_idx").on(t.placedAt),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    titleSnapshot: text("title_snapshot").notNull(),
    imageSnapshot: text("image_snapshot"),
    unitPrice: integer("unit_price").notNull(),
    qty: integer("qty").notNull(),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

export const orderEvents = pgTable(
  "order_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("order_events_order_idx").on(t.orderId)],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    body: text("body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reviews_product_idx").on(t.productId)],
);

export const coupons = pgTable(
  "coupons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    kind: text("kind").notNull().default("pct"), // pct|flat
    value: integer("value").notNull(), // pct = percent, flat = paise
    minSubtotal: integer("min_subtotal").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("coupons_code_idx").on(t.code)],
);
