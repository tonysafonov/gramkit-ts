CREATE TABLE "admin_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"actor_telegram_id" bigint,
	"actor_username" varchar(128),
	"actor_role" varchar(20) NOT NULL,
	"action" varchar(64) NOT NULL,
	"target_type" varchar(64),
	"target_id" varchar(64),
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balances" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"id" bigserial NOT NULL,
	"user_id1" uuid NOT NULL,
	"user_id2" uuid NOT NULL,
	"is_active" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendships_pkey" PRIMARY KEY("user_id1","user_id2")
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"id" serial NOT NULL,
	"group_id" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"is_admin" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_pkey" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(255),
	"photo_url" varchar(255),
	"creator_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_invites" (
	"code" varchar(12) PRIMARY KEY NOT NULL,
	"creator_id" uuid NOT NULL,
	"group_id" integer NOT NULL,
	"used_count" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(40) NOT NULL,
	"channel" varchar(120),
	"price_rub" double precision,
	"published_on" date,
	"created_by" varchar(128),
	"is_archived" boolean DEFAULT false NOT NULL,
	"alerts_sent" json DEFAULT '[]'::json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_links_code_key" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"template" varchar(64) NOT NULL,
	"message_key" varchar(128) NOT NULL,
	"slot" varchar(16) NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered" boolean NOT NULL,
	"error_code" varchar(32)
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_id" varchar(14) NOT NULL,
	"event_type" varchar(17) NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"raw_data" json NOT NULL,
	"is_recurring" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"product_id" varchar(50) NOT NULL,
	"provider_id" varchar(14) NOT NULL,
	"amount" double precision NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" varchar(18) NOT NULL,
	"subscription_id" uuid,
	"is_recurring" boolean NOT NULL,
	"was_rewarded" boolean NOT NULL,
	"idempotency_key" varchar(64),
	"provider_payment_id" varchar(255),
	"provider_metadata" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotional_broadcasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_type" varchar(20) NOT NULL,
	"message_text" text,
	"message_html" text,
	"media_file_id" varchar(255),
	"caption" text,
	"caption_html" text,
	"media_metadata" jsonb,
	"has_text_formatting" boolean NOT NULL,
	"has_caption_formatting" boolean NOT NULL,
	"time_slot" varchar(7) NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"priority" integer NOT NULL,
	"keyboard_type" varchar(50),
	"keyboard_button_text" varchar(255),
	"created_by_user_id" bigint NOT NULL,
	"is_active" boolean NOT NULL,
	"completed_at" timestamp with time zone,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"cycles_run" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"target_filter" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"product_id" varchar(50) NOT NULL,
	"provider_id" varchar(14) NOT NULL,
	"status" varchar(8) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"canceled_at" timestamp with time zone,
	"cancellation_reason" varchar(50),
	"cancellation_feedback" text,
	"recurring_details" json NOT NULL,
	"failed_renewal_count" integer DEFAULT 0 NOT NULL,
	"last_renewal_attempt_at" timestamp with time zone,
	"payment_method_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_type" varchar(10) NOT NULL,
	"role" varchar(20) NOT NULL,
	"display_name" varchar(255),
	"username" varchar(128),
	"avatar_url" varchar(500),
	"language_code" varchar(10),
	"timezone" varchar(50),
	"birth_date" date,
	"male" boolean,
	"telegram_id" bigint,
	"tg_first_name" varchar(64),
	"tg_last_name" varchar(64),
	"tg_username" varchar(32),
	"tg_language_code" varchar(8),
	"tg_is_premium" boolean,
	"tg_photo_url" varchar(500),
	"tg_is_bot" boolean,
	"tg_added_to_attachment_menu" boolean,
	"tg_allows_write_to_pm" boolean,
	"email" varchar(255),
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" varchar(255),
	"last_login_at" timestamp with time zone,
	"current_streak" integer NOT NULL,
	"best_streak" integer NOT NULL,
	"total_active_days" integer NOT NULL,
	"last_activity_date" date,
	"is_onboarded" boolean,
	"is_terms_accepted" boolean,
	"referral_code" varchar(40),
	"bot_blocked_at" timestamp with time zone,
	"seen_features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_id_key" UNIQUE("telegram_id"),
	CONSTRAINT "uq_users_email" UNIQUE("email"),
	CONSTRAINT "uq_users_username" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "failed_webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" varchar(50) NOT NULL,
	"payload" json NOT NULL,
	"error_message" text NOT NULL,
	"error_type" varchar(50) NOT NULL,
	"retry_count" integer NOT NULL,
	"last_retry_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_id1_fkey" FOREIGN KEY ("user_id1") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_id2_fkey" FOREIGN KEY ("user_id2") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_admin_audit_logs_created_at" ON "admin_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_admin_audit_logs_actor_user_id" ON "admin_audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "ix_admin_audit_logs_action" ON "admin_audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "ix_friendships_user_id1" ON "friendships" USING btree ("user_id1");--> statement-breakpoint
CREATE INDEX "ix_friendships_user_id2" ON "friendships" USING btree ("user_id2");--> statement-breakpoint
CREATE INDEX "ix_notification_deliveries_user_id_sent_at" ON "notification_deliveries" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX "ix_payment_events_payment_id" ON "payment_events" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "ix_payments_user_id" ON "payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_payments_subscription_id" ON "payments" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "ix_payments_provider_payment_id" ON "payments" USING btree ("provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payment_idempotency_key" ON "payments" USING btree ("idempotency_key") WHERE idempotency_key IS NOT NULL AND status NOT IN ('FAILED', 'CANCELED');--> statement-breakpoint
CREATE INDEX "ix_subscriptions_user_id" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_subscription_active_user" ON "subscriptions" USING btree ("user_id") WHERE status IN ('ACTIVE', 'PAST_DUE', 'PENDING');--> statement-breakpoint
CREATE INDEX "ix_users_role" ON "users" USING btree ("role");--> statement-breakpoint
-- Both repeat their table's primary key, and Postgres silently drops such a duplicate inside a CREATE TABLE. A migrated
-- Python database has them, so they are added separately.
ALTER TABLE "friendships" ADD CONSTRAINT "uq_friendship" UNIQUE("user_id1","user_id2");--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_code_key" UNIQUE("code");
