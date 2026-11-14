-- Delivery charge on the bill: the figure the frozen calculation adds before the coupon.
-- Default 0 keeps every existing invoice (none charged shipping) arithmetically identical.
ALTER TABLE "invoices" ADD COLUMN "shipping_minor" INTEGER NOT NULL DEFAULT 0;
