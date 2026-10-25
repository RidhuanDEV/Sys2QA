# Next.js fixture (IMP-107)

Proves the `nextjs` row of the js-ts support matrix. Expected: pages `page:app:/`, `page:app:/orders/{id}` (the route
group `(shop)` is not part of the path) and `page:app:/legacy`; endpoints `api:GET:/api/orders`, `api:POST:/api/orders`
and `api:ANY:/api/health`; `pages/_app.tsx` is not a page.
