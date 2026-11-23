import http from "k6/http";
import * as lt from "./litetraffic/runtime.js";

export const options = lt.options();

const MAX_PAY_ATTEMPTS = 3;

// One customer: place an order, then pay for it. Like any real client, the customer tries again when a
// payment request gets no usable reply. That retry is what a non-idempotent payment endpoint mishandles.
export default function purchase() {
  const ref = lt.journeyKey();
  const headers = { "Content-Type": "application/json", "Idempotency-Key": ref };

  const order = http.post(`${__ENV.LT_TARGET}/orders`, JSON.stringify({ ref, amount: 1250 }), {
    headers,
    tags: { operation: "order" },
  });
  if (order.status === 201) lt.stage("ordered");

  let payment;
  let attempts = 0;
  do {
    attempts += 1;
    payment = http.post(`${__ENV.LT_TARGET}/payments`, JSON.stringify({ order_ref: ref }), {
      headers,
      tags: { operation: "pay" },
    });
  } while (payment.status >= 500 && attempts < MAX_PAY_ATTEMPTS);

  const paid = [200, 201].includes(payment.status);
  if (paid) lt.stage("paid");
  lt.evidence("customer_payment_succeeds", order.status === 201 && paid, {
    expected: { order: 201, payment: [200, 201] },
    actual: { order: order.status, payment: payment.status, attempts },
  });
}
