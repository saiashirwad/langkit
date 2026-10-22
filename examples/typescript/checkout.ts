import { Checkout, LineItem, Order, Payment, PaymentId } from "../domain/checkout.domain";

const address = { name: "Sai", line1: "1 Loop Road", city: "Bengaluru", postcode: "560001" };
const keyboard = LineItem.parse({ sku: "kbd-60", quantity: 1, cents: 12900 });
const paymentId = PaymentId.parse("pi_1");

const cart = Order.start({ items: [] }).edit({ items: [keyboard] });
const checkedOut = cart.checkout({ address });
const challenged = Payment.start({ cents: 12900 }).challenge({ paymentId, challengeUrl: "https://bank.example/3ds" });
const { order: paid, payment: captured } = Checkout.pay(
  { order: checkedOut, payment: challenged.verify() },
  { paymentId, paidAt: "2026-10-22T09:00:00Z" },
);

const refuses = (misuse: () => unknown): boolean => {
  try {
    misuse();
    return false;
  } catch {
    return true;
  }
};

const payDirectly = () => {
  // @ts-expect-error pay is a sync event: only Checkout.pay fires it, together with the payment's capture.
  return checkedOut.pay({ paymentId, paidAt: "2026-10-22T09:01:00Z" });
};

const payUnauthorized = () => {
  // @ts-expect-error A pending payment has not been authorized, so the checkout cannot capture it.
  return Checkout.pay({ order: checkedOut, payment: Payment.start({ cents: 12900 }) }, { paymentId, paidAt: "now" });
};

const shipUntracked = () => {
  // @ts-expect-error Shipping needs a tracking number.
  return paid.ship({ carrier: "Courier" });
};

console.log(refuses(payDirectly), refuses(payUnauthorized), refuses(shipUntracked));

const shipped = paid.ship({ carrier: "Courier", tracking: "TRK123" });
console.log(shipped.state, shipped.carrier, shipped.items.length, cart.state, captured.state);

/** One step forward from wherever a stored order is. The switch must be exhaustive to type-check. */
const advance = (order: Order): Order => {
  switch (order.state) {
    case "Cart":
      return order.checkout({ address });
    case "Paid":
      return order.ship({ carrier: "Post", tracking: "TRK456" });
    case "Shipped":
      return order.deliver({ deliveredAt: "2026-10-24T12:00:00Z" });
    case "Checkout":
    case "Refunding":
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

const partly = captured.refundPart({ refunded: 2900 });
const { order: refunded, payment: settled } = Checkout.refund(
  { order: paid.cancel({ reason: "OutOfStock" }), payment: partly },
  { refundId: "re_2" },
);
console.log(receipt(refunded), settled.state, Object.isFrozen(refunded));

const retried = Payment.start({ cents: 500 }).decline({ reason: "InsufficientFunds" }).retry();
console.log(retried.state, Checkout.paidOrdersAreCaptured({ order: shipped, payment: partly }));

try {
  Order.parse({ state: "Shipped", items: [keyboard] });
} catch (error) {
  console.log(error instanceof TypeError ? error.message : error);
}
