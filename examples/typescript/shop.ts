import { Address, Cents, LineItem, OrderId, PaymentId, PayMethod } from "../domain/commerce.domain";
import { Fulfilment } from "../domain/fulfilment.domain";
import { Order } from "../domain/order.domain";
import { Payment } from "../domain/payment.domain";
import { Shop } from "../domain/shop.domain";

const address = Address.parse(
  JSON.parse("{\"name\":\"Sai\",\"line1\":\"1 Loop Road\",\"city\":\"Bengaluru\",\"postcode\":\"560001\"}"),
);
const keyboard = LineItem.parse({ sku: "kbd-60", quantity: 1, price: 12900 });
const card = PayMethod.parse({ tag: "Card", last4: "4242" });

const cart = Order.start({ id: OrderId.parse("ord_1"), items: [keyboard] });
const pending = Payment.start({ amount: Cents.parse(12900) });

const checkedOut = Shop.checkout(
  { order: cart, payment: pending },
  { address, paymentId: PaymentId.parse("pi_1"), method: card },
);
const paid = Shop.pay({ ...checkedOut, warehouse: Fulfilment.start() });
const exact: { order: Order.Paid; payment: Payment.Captured; warehouse: Fulfilment.Reserved; } = paid;

const shipped = paid.order.ship({ carrier: "Courier", tracking: "TRK123" });
const dispatched = paid.warehouse.dispatch({ carrier: "Courier", tracking: "TRK123" });
console.log(exact.order.state, shipped.state, dispatched.state);

const describe = (method: PayMethod): string =>
  method.tag === "Card" ? `card ending ${method.last4}` : `transfer ${method.reference}`;
console.log(describe(paid.payment.method));

const refuses = (misuse: () => unknown): boolean => {
  try {
    misuse();
    return false;
  } catch {
    return true;
  }
};

const payBeforeCheckout = () =>
  // @ts-expect-error A cart has not checked out, so the shop cannot take payment for it.
  Shop.pay({ order: cart, payment: checkedOut.payment, warehouse: Fulfilment.start() });

const captureDirectly = () =>
  // @ts-expect-error capture is a sync event: only Shop.pay fires it, with the order and the warehouse.
  checkedOut.payment.capture();

const authorizeWithoutMethod = () =>
  // @ts-expect-error The synced checkout needs the method that payment.authorize takes.
  Shop.checkout({ order: cart, payment: pending }, { address, paymentId: PaymentId.parse("pi_1") });

const swappedIds = () =>
  // @ts-expect-error A payment id is not an order id, though both are strings at run time.
  Order.start({ id: PaymentId.parse("pi_1"), items: [] });

console.log(refuses(payBeforeCheckout), refuses(captureDirectly), refuses(authorizeWithoutMethod), swappedIds().state);

/** A webhook over stored rows. The sync only type-checks once both rows are narrowed. */
const refundCancelled = (order: Order, payment: Payment) => {
  if (order.state !== "Refunding" || payment.state !== "Captured") return undefined;
  const { order: cancelled, payment: refunded } = Shop.refund({ order, payment });
  return `${cancelled.reason} ${refunded.state}`;
};

const cancelled = paid.order.cancel({ reason: "OutOfStock" });
const rows = JSON.parse(JSON.stringify({ order: cancelled, payment: paid.payment }));
console.log(refundCancelled(Order.parse(rows.order), Payment.parse(rows.payment)));

/** A nightly audit over rows older code wrote. The predicate takes only the parts its formula names. */
const shippedAfterRefund = (rows: readonly Pick<Shop.Parts, "payment" | "warehouse">[]) =>
  rows.filter((row) => !Shop.refundsNeverShip(row));

const race = { payment: Shop.refund({ order: cancelled, payment: paid.payment }).payment, warehouse: dispatched };
console.log(shippedAfterRefund([race, { payment: paid.payment, warehouse: dispatched }]).length);
console.log(Shop.capturesOnlyPaid({ order: shipped, payment: paid.payment }));
