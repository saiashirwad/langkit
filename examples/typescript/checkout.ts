import { Order } from "../domain/checkout.domain";

const address = { name: "Sai", line1: "1 Loop Road", city: "Bengaluru", postcode: "560001" };
const keyboard = { sku: "kbd-60", quantity: 1, cents: 12900 };

const cart = Order.start({ items: [] }).edit({ items: [keyboard] });
const paid = cart.checkout({ address }).pay({ paymentId: "pi_1", paidAt: "2026-10-22T09:00:00Z" });

const refuses = (misuse: () => unknown): boolean => {
  try {
    misuse();
    return false;
  } catch {
    return true;
  }
};

const payTwice = () => {
  // @ts-expect-error A paid order cannot be paid again.
  return paid.pay({ paymentId: "pi_2", paidAt: "2026-10-22T09:01:00Z" });
};

const shipUntracked = () => {
  // @ts-expect-error Shipping needs a tracking number.
  return paid.ship({ carrier: "Courier" });
};

console.log(refuses(payTwice), refuses(shipUntracked));

const shipped = paid.ship({ carrier: "Courier", tracking: "TRK123" });
console.log(shipped.state, shipped.carrier, shipped.items.length, cart.state);

/** One step forward from wherever a stored order is. The switch must be exhaustive to type-check. */
const advance = (order: Order): Order => {
  switch (order.state) {
    case "Cart":
      return order.checkout({ address });
    case "Checkout":
      return order.pay({ paymentId: "pi_3", paidAt: "2026-10-22T10:00:00Z" });
    case "Paid":
      return order.ship({ carrier: "Post", tracking: "TRK456" });
    case "Shipped":
      return order.deliver({ deliveredAt: "2026-10-24T12:00:00Z" });
    case "Refunding":
      return order.refund({ refundId: "re_1" });
    case "Delivered":
    case "Cancelled":
      return order;
  }
};

const receipt = (order: Order.Final): string =>
  order.state === "Delivered" ? `delivered ${order.deliveredAt}` : `cancelled: ${order.reason} ${order.refundId}`;

const stored = JSON.stringify(shipped);
const restored = Order.parse(JSON.parse(stored));
const done = advance(restored);
if (done.state === "Delivered" || done.state === "Cancelled") console.log(stored, receipt(done));

const refunded = paid.cancel({ reason: "OutOfStock" }).refund({ refundId: "re_2" });
console.log(receipt(refunded), Object.isFrozen(refunded));

try {
  Order.parse({ state: "Shipped", items: [keyboard] });
} catch (error) {
  console.log(error instanceof TypeError ? error.message : error);
}
