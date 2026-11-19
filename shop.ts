// Shared between client and server: money, statuses, formatting.

export const ORDER_STATUSES = [
  "placed",
  "packed",
  "shipped",
  "out_for_delivery",
  "delivered",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  placed: "Order placed",
  packed: "Packed",
  shipped: "Shipped",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

/** The happy-path progression, used to draw the tracking timeline. */
export const TRACKING_STEPS: OrderStatus[] = [
  "placed",
  "packed",
  "shipped",
  "out_for_delivery",
  "delivered",
];

export const PAYMENT_METHODS = ["cod", "razorpay"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const FREE_SHIPPING_THRESHOLD = 49900; // ₹499
export const SHIPPING_FEE = 4900; // ₹49

/** Integer paise → "₹1,299" (no decimals when whole, else 2 dp). */
export function formatINR(paise: number): string {
  const rupees = paise / 100;
  const hasPaise = Math.round(paise) % 100 !== 0;
  return (
    "₹" +
    rupees.toLocaleString("en-IN", {
      minimumFractionDigits: hasPaise ? 2 : 0,
      maximumFractionDigits: 2,
    })
  );
}

/** Rupees (as typed in an admin form) → integer paise. */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: number): number {
  return Math.round(paise) / 100;
}

/** Discount % implied by mrp vs price, rounded to a whole number. */
export function discountFromPrices(price: number, mrp: number): number {
  if (mrp <= 0 || price >= mrp) return 0;
  return Math.round(((mrp - price) / mrp) * 100);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function shippingFor(subtotal: number): number {
  return subtotal >= FREE_SHIPPING_THRESHOLD || subtotal === 0 ? 0 : SHIPPING_FEE;
}

export const SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "rating", label: "Customer rating" },
  { value: "newest", label: "Newest first" },
  { value: "discount", label: "Biggest discount" },
] as const;

export type SortOption = (typeof SORT_OPTIONS)[number]["value"];
