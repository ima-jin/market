CREATE TABLE IF NOT EXISTS "market"."checkouts" (
	"session_id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"payment_id" text,
	"listing_id" text NOT NULL,
	"seller_did" text NOT NULL,
	"buyer_did" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"chain" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp with time zone,
	CONSTRAINT "checkouts_transaction_id_unique" UNIQUE("transaction_id"),
	CONSTRAINT "checkouts_payment_id_unique" UNIQUE("payment_id"),
	CONSTRAINT "checkouts_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "market"."listings"("id") ON DELETE no action ON UPDATE no action
);
