# Why this project exists

Two failure modes, both common in student and small-team SaaS apps:

1. Tenant leakage. A developer writes `orders.find({ status: "paid" })`
   and forgets the tenant. If the app serves multiple customers from one
   database, that one missing filter exposes another customer's data.
   Code review does not reliably catch a missing filter in every query.

2. Half-completed writes. Checkout does two writes: decrement stock,
   create order. If the second fails and the first is not rolled back,
   the shop's inventory and its orders disagree.

mongo-saas-kit does not try to be a framework. It contains two small
libraries that fix those two modes, and an example that shows them
working together. That is the whole scope, on purpose.
