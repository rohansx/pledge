import http from "k6/http";
import * as lt from "./litetraffic/runtime.js";

export const options = lt.options();

const MAX_ATTEMPTS = 4;

function post(path, body, operation) {
  const params = {
    headers: { "content-type": "application/json", "X-LiteTraffic-Run": __ENV.LT_RUN_ID },
    tags: { operation },
    timeout: "15s",
  };
  let res = null;
  // A real client retries when it gets no usable reply (network error or 5xx).
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = http.post(`${__ENV.LT_TARGET}${path}`, JSON.stringify(body), params);
    if (res.status !== 0 && res.status < 500) break;
  }
  return res;
}

export default function () {
  const key = lt.journeyKey();
  const rng = lt.rng();
  const ref = `ord-${key}`;
  const amount = 100 + Math.floor(rng() * 9900);

  const created = post("/orders", { ref, amount }, "create_order");
  const createdOk = created.status === 201;
  lt.evidence("order_created", createdOk, { expected: 201, actual: created.status });
  if (createdOk) lt.stage("order_created");

  let paidOk = false;
  let payStatus = null;
  if (createdOk) {
    const paid = post("/payments", { order_ref: ref }, "pay");
    payStatus = paid.status;
    paidOk = paid.status === 200 || paid.status === 201;
    if (paidOk) lt.stage("paid");
  }
  lt.evidence("payment_accepted", paidOk, { expected: "200 or 201", actual: payStatus });

  const read = http.get(`${__ENV.LT_TARGET}/orders/${encodeURIComponent(ref)}`, {
    headers: { "X-LiteTraffic-Run": __ENV.LT_RUN_ID },
    tags: { operation: "read_order" },
  });
  let order = null;
  if (read.status === 200) {
    try {
      order = read.json();
    } catch (e) {
      order = null;
    }
  }
  const payments = order ? order.payments : null;
  const status = order ? order.status : null;
  const readAmount = order ? order.amount : null;
  lt.evidence("order_has_one_payment", payments === 1, {
    expected: 1,
    actual: payments,
    detail: `read status ${read.status}`,
  });
  lt.evidence("order_status_paid", status === "paid", { expected: "paid", actual: status });
  lt.evidence("order_amount_unchanged", readAmount === amount, { expected: amount, actual: readAmount });
  if (order && payments === 1 && status === "paid") lt.stage("verified");
}
