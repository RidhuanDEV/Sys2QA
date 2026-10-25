CREATE TABLE "Order" (
  "id" TEXT PRIMARY KEY,
  "customerId" TEXT NOT NULL REFERENCES "User" ("id"),
  "amount" INTEGER NOT NULL CHECK ("amount" BETWEEN 1 AND 10000),
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "approvedBy" TEXT,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
);
