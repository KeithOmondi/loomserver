--
-- PostgreSQL database dump
--


-- Dumped from database version 18.6 (4e5fd08)
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: neon_auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA neon_auth;


--
-- Name: ltree; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS ltree WITH SCHEMA public;


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: generate_category_slug(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_category_slug(name text) RETURNS text
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN LOWER(
        REGEXP_REPLACE(
            REGEXP_REPLACE(name, '[^a-zA-Z0-9\s-]', '', 'g'),
            '\s+', '-', 'g'
        )
    );
END;
$$;


--
-- Name: generate_store_slug(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_store_slug(name text) RETURNS text
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN LOWER(
        REGEXP_REPLACE(
            REGEXP_REPLACE(name, '[^a-zA-Z0-9\s-]', '', 'g'),
            '\s+', '-', 'g'
        )
    );
END;
$$;


--
-- Name: jsonb_to_text_array(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jsonb_to_text_array(j jsonb) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(j)),
    ARRAY[]::text[]
  );
$$;


--
-- Name: set_category_slug(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_category_slug() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.slug IS NULL OR NEW.slug = '' THEN
        NEW.slug := generate_category_slug(NEW.name);
        -- Ensure uniqueness
        WHILE EXISTS (SELECT 1 FROM categories WHERE slug = NEW.slug AND id != NEW.id) LOOP
            NEW.slug := NEW.slug || '-' || floor(random() * 1000)::TEXT;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: set_store_slug(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_store_slug() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.slug IS NULL OR NEW.slug = '' THEN
        NEW.slug := generate_store_slug(NEW.name);
        -- Ensure uniqueness
        WHILE EXISTS (SELECT 1 FROM stores WHERE slug = NEW.slug AND id != NEW.id) LOOP
            NEW.slug := NEW.slug || '-' || floor(random() * 1000)::TEXT;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.account (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" uuid NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: invitation; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.invitation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "organizationId" uuid NOT NULL,
    email text NOT NULL,
    role text,
    status text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "inviterId" uuid NOT NULL
);


--
-- Name: jwks; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.jwks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "expiresAt" timestamp with time zone,
    alg text,
    crv text
);


--
-- Name: member; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.member (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "organizationId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    role text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL
);


--
-- Name: organization; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.organization (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    logo text,
    "createdAt" timestamp with time zone NOT NULL,
    metadata text
);


--
-- Name: project_config; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.project_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    endpoint_id text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    trusted_origins jsonb NOT NULL,
    social_providers jsonb NOT NULL,
    email_provider jsonb,
    email_and_password jsonb,
    allow_localhost boolean NOT NULL,
    plugin_configs jsonb,
    webhook_config jsonb
);


--
-- Name: session; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" uuid NOT NULL,
    "impersonatedBy" text,
    "activeOrganizationId" text
);


--
-- Name: user; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth."user" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    role text,
    banned boolean,
    "banReason" text,
    "banExpires" timestamp with time zone
);


--
-- Name: verification; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.verification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    label text,
    first_name text CONSTRAINT addresses_full_name_not_null NOT NULL,
    phone text NOT NULL,
    address_line1 text CONSTRAINT addresses_line1_not_null NOT NULL,
    address_line2 text,
    city text NOT NULL,
    state text,
    country text DEFAULT 'KE'::text NOT NULL,
    postal_code text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_name text DEFAULT ''::text NOT NULL,
    email text,
    company text,
    instructions text
);


--
-- Name: attribute_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attribute_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    slug character varying(100) NOT NULL,
    type character varying(50) NOT NULL,
    description text,
    is_required boolean DEFAULT false,
    is_filterable boolean DEFAULT true,
    is_variant boolean DEFAULT false,
    sort_order integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: attribute_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attribute_options (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attribute_id uuid NOT NULL,
    value character varying(255) NOT NULL,
    slug character varying(255) NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: cart_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cart_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cart_id uuid NOT NULL,
    product_id uuid NOT NULL,
    variant_id uuid,
    quantity integer NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cart_items_quantity_check CHECK ((quantity > 0))
);


--
-- Name: carts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.carts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    guest_token uuid,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT carts_check CHECK ((((user_id IS NOT NULL) AND (guest_token IS NULL)) OR ((user_id IS NULL) AND (guest_token IS NOT NULL))))
);


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    slug character varying(100) NOT NULL,
    description text,
    parent_id uuid,
    image_url character varying(500),
    icon character varying(50),
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true,
    is_featured boolean DEFAULT false NOT NULL,
    meta_title character varying(255),
    meta_description text,
    meta_keywords text,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    path public.ltree NOT NULL,
    depth integer DEFAULT 0 NOT NULL,
    is_leaf boolean DEFAULT false NOT NULL,
    type character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    seo jsonb DEFAULT '{}'::jsonb NOT NULL,
    product_count integer DEFAULT 0 NOT NULL,
    child_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT categories_depth_check CHECK (((depth >= 0) AND (depth <= 5))),
    CONSTRAINT categories_no_self_parent CHECK ((parent_id IS DISTINCT FROM id)),
    CONSTRAINT categories_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'archived'::character varying])::text[]))),
    CONSTRAINT categories_type_check CHECK (((type)::text = ANY ((ARRAY['department'::character varying, 'category'::character varying, 'subcategory'::character varying, 'leaf'::character varying])::text[])))
);


--
-- Name: category_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.category_attributes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category_id uuid NOT NULL,
    attribute_id uuid NOT NULL,
    is_required boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: moderation_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.moderation_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    moderator_id uuid NOT NULL,
    action character varying(50) NOT NULL,
    target_type character varying(50) NOT NULL,
    target_id uuid NOT NULL,
    notes text,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT moderation_history_target_type_check CHECK (((target_type)::text = ANY (ARRAY[('store'::character varying)::text, ('product'::character varying)::text, ('seller'::character varying)::text, ('review'::character varying)::text, ('content'::character varying)::text, ('dispute'::character varying)::text])))
);


--
-- Name: moderation_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.moderation_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    target_type character varying(50) NOT NULL,
    target_id uuid NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    priority character varying(50) DEFAULT 'medium'::character varying NOT NULL,
    submitted_by uuid NOT NULL,
    submitted_at timestamp without time zone DEFAULT now(),
    moderated_by uuid,
    moderated_at timestamp without time zone,
    notes text,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT moderation_queue_priority_check CHECK (((priority)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('urgent'::character varying)::text]))),
    CONSTRAINT moderation_queue_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('in_review'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('flagged'::character varying)::text, ('suspended'::character varying)::text, ('removed'::character varying)::text, ('resolved'::character varying)::text]))),
    CONSTRAINT moderation_queue_target_type_check CHECK (((target_type)::text = ANY (ARRAY[('store'::character varying)::text, ('product'::character varying)::text, ('seller'::character varying)::text, ('review'::character varying)::text, ('content'::character varying)::text, ('dispute'::character varying)::text])))
);


--
-- Name: mpesa_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mpesa_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    merchant_request_id text,
    checkout_request_id text,
    mpesa_receipt text,
    phone text NOT NULL,
    amount numeric(10,2) NOT NULL,
    status text DEFAULT 'initiated'::text NOT NULL,
    result_code text,
    result_desc text,
    request_payload jsonb,
    callback_payload jsonb,
    initiated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    product_id uuid NOT NULL,
    variant_id uuid,
    quantity integer DEFAULT 1 NOT NULL,
    price numeric(10,2) NOT NULL,
    total numeric(10,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: order_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_number character varying(50) NOT NULL,
    store_id uuid NOT NULL,
    user_id uuid NOT NULL,
    seller_id uuid NOT NULL,
    customer jsonb NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    subtotal numeric(10,2) DEFAULT 0 NOT NULL,
    discount_total numeric(10,2) DEFAULT 0 NOT NULL,
    tax_total numeric(10,2) DEFAULT 0 NOT NULL,
    shipping_total numeric(10,2) DEFAULT 0 NOT NULL,
    total numeric(10,2) DEFAULT 0 NOT NULL,
    currency character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    shipping jsonb NOT NULL,
    payment jsonb NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    fulfillment_status character varying(50) DEFAULT 'unfulfilled'::character varying NOT NULL,
    payment_status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    customer_notes text,
    seller_notes text,
    admin_notes text,
    placed_at timestamp with time zone DEFAULT now() NOT NULL,
    payment_confirmed_at timestamp with time zone,
    processed_at timestamp with time zone,
    shipped_at timestamp with time zone,
    delivered_at timestamp with time zone,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    refunded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    payment_group_id uuid
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: product_attribute_option_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_attribute_option_values (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    attribute_id uuid NOT NULL,
    value_option_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: product_attribute_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_attribute_values (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    attribute_id uuid NOT NULL,
    value_text text,
    value_number numeric,
    value_boolean boolean,
    value_date date,
    value_option_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: product_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_images (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    url text NOT NULL,
    public_id text NOT NULL,
    alt_text character varying(255),
    is_primary boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: product_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    user_id uuid NOT NULL,
    order_id uuid,
    rating integer NOT NULL,
    title character varying(255),
    comment text,
    images jsonb DEFAULT '[]'::jsonb,
    is_verified_purchase boolean DEFAULT false,
    is_approved boolean DEFAULT false,
    status character varying(20) DEFAULT 'pending'::character varying,
    helpful_count integer DEFAULT 0,
    moderated_by uuid,
    moderated_at timestamp with time zone,
    moderation_reason text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    CONSTRAINT product_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5))),
    CONSTRAINT product_reviews_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('flagged'::character varying)::text])))
);


--
-- Name: product_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_views (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    user_id uuid,
    ip_address inet,
    user_agent text,
    count integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_id uuid NOT NULL,
    seller_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(255) NOT NULL,
    description text,
    short_description character varying(500),
    type character varying(20) DEFAULT 'physical'::character varying NOT NULL,
    condition character varying(20) DEFAULT 'new'::character varying,
    visibility character varying(20) DEFAULT 'public'::character varying,
    category_id uuid,
    tags text[] DEFAULT ARRAY[]::text[] NOT NULL,
    price numeric(10,2) DEFAULT 0 NOT NULL,
    compare_at_price numeric(10,2),
    cost_per_item numeric(10,2),
    tax_class character varying(50),
    is_taxable boolean DEFAULT true,
    sku character varying(100),
    barcode character varying(50),
    stock_quantity integer DEFAULT 0,
    stock_status character varying(20) DEFAULT 'out_of_stock'::character varying,
    low_stock_threshold integer,
    allow_backorders boolean DEFAULT false,
    allow_preorders boolean DEFAULT false,
    preorder_release_date timestamp with time zone,
    weight numeric(10,2),
    weight_unit character varying(10) DEFAULT 'kg'::character varying,
    dimensions jsonb,
    requires_shipping boolean DEFAULT true,
    shipping_class character varying(50),
    video_url character varying(500),
    has_variants boolean DEFAULT false,
    digital_file_url character varying(500),
    digital_file_size numeric(10,2),
    digital_file_name character varying(255),
    license_key character varying(255),
    status character varying(20) DEFAULT 'draft'::character varying,
    is_active boolean DEFAULT false,
    is_approved boolean DEFAULT false,
    is_featured boolean DEFAULT false,
    rejection_reason text,
    moderated_at timestamp with time zone,
    moderated_by uuid,
    moderation_notes text,
    view_count integer DEFAULT 0,
    wishlist_count integer DEFAULT 0,
    order_count integer DEFAULT 0,
    average_rating numeric(3,2) DEFAULT 0,
    total_reviews integer DEFAULT 0,
    sales_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    published_at timestamp with time zone,
    deleted_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    seo jsonb DEFAULT '{}'::jsonb NOT NULL,
    variant_attribute_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    CONSTRAINT products_lifecycle_consistency CHECK (((((status)::text = 'active'::text) AND (is_active = true) AND (is_approved = true)) OR (((status)::text <> 'active'::text) AND (is_active = false) AND (is_approved = false)))),
    CONSTRAINT products_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'pending'::character varying, 'active'::character varying, 'suspended'::character varying, 'rejected'::character varying, 'discontinued'::character varying])::text[]))),
    CONSTRAINT products_stock_status_check CHECK (((stock_status)::text = ANY ((ARRAY['in_stock'::character varying, 'out_of_stock'::character varying, 'backorder'::character varying, 'preorder'::character varying, 'discontinued'::character varying])::text[])))
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    user_agent text,
    ip_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    replaced_by uuid
);


--
-- Name: returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.returns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_item_id uuid,
    user_id uuid NOT NULL,
    reason text,
    status character varying(20) DEFAULT 'pending'::character varying,
    refund_amount numeric(10,2),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: sellers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sellers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    business_name character varying(255) NOT NULL,
    business_type character varying(50),
    tax_id character varying(50) NOT NULL,
    registration_number character varying(100) NOT NULL,
    country character varying(100) NOT NULL,
    state character varying(100) NOT NULL,
    city character varying(100) NOT NULL,
    business_address text NOT NULL,
    store_name character varying(255) NOT NULL,
    store_description text,
    store_logo_url text,
    store_banner_url text,
    store_url_slug character varying(255),
    bank_account_name character varying(255),
    bank_account_number character varying(50),
    bank_routing_number character varying(50),
    bank_name character varying(255),
    paypal_email character varying(255),
    stripe_connect_id character varying(255),
    rating numeric(3,2) DEFAULT 0,
    total_reviews integer DEFAULT 0,
    total_orders integer DEFAULT 0,
    total_products integer DEFAULT 0,
    fulfillment_rate numeric(5,2) DEFAULT 100,
    response_rate numeric(5,2) DEFAULT 100,
    response_time_hours integer,
    verification_status character varying(50) DEFAULT 'pending'::character varying,
    verification_documents jsonb,
    verified_at timestamp without time zone,
    rejected_reason text,
    commission_rate numeric(5,2) DEFAULT 10.00,
    payout_schedule character varying(50) DEFAULT 'weekly'::character varying,
    minimum_payout numeric(10,2) DEFAULT 50.00,
    auto_approve_products boolean DEFAULT false,
    enable_negotiation boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    suspended_at timestamp without time zone,
    suspended_reason text,
    trading_name character varying(255) NOT NULL,
    mpesa_phone character varying(20),
    payout_method character varying(50) DEFAULT 'bank'::character varying,
    status character varying(50) DEFAULT 'pending'::character varying,
    business_phone character varying(20) NOT NULL,
    bank_country character varying(100),
    currency character varying(3) DEFAULT 'USD'::character varying,
    hold_period_days integer DEFAULT 7,
    tier character varying(50) DEFAULT 'basic'::character varying,
    max_stores_allowed integer DEFAULT 1,
    max_products_per_store integer DEFAULT 100,
    allow_backorders boolean DEFAULT false,
    allow_preorders boolean DEFAULT false,
    cancellation_rate double precision DEFAULT 0,
    dispute_rate double precision DEFAULT 0,
    custom_commission_rate double precision,
    created_by uuid,
    updated_by uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    kyc_expiry_date timestamp with time zone,
    last_kyc_review_date timestamp with time zone,
    risk_score integer DEFAULT 0,
    total_stores integer DEFAULT 0,
    kyc_documents jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: store_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_id uuid NOT NULL,
    user_id uuid NOT NULL,
    order_id uuid,
    rating integer NOT NULL,
    title character varying(255),
    comment text,
    images jsonb DEFAULT '[]'::jsonb,
    is_verified_purchase boolean DEFAULT false,
    is_approved boolean DEFAULT false,
    status character varying(20) DEFAULT 'pending'::character varying,
    helpful_count integer DEFAULT 0,
    moderated_by uuid,
    moderated_at timestamp with time zone,
    moderation_reason text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    CONSTRAINT store_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5))),
    CONSTRAINT store_reviews_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('flagged'::character varying)::text])))
);


--
-- Name: stores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seller_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    slug character varying(100) NOT NULL,
    description text,
    logo_url character varying(500),
    banner_url character varying(500),
    location character varying(255),
    contact_email character varying(255),
    contact_phone character varying(50),
    social_links jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT false,
    is_approved boolean DEFAULT false,
    approved_at timestamp without time zone,
    approved_by uuid,
    rejection_reason text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    legal_name character varying(255),
    date_of_birth date,
    government_id_type character varying(50),
    government_id_number character varying(100),
    government_id_url character varying(500),
    government_id_public_id character varying(200),
    id_verified boolean DEFAULT false,
    id_verified_at timestamp without time zone,
    id_verified_by uuid,
    kra_pin character varying(50),
    kra_certificate_url character varying(500),
    kra_certificate_public_id character varying(200),
    tax_verified boolean DEFAULT false,
    tax_verified_at timestamp without time zone,
    tax_verified_by uuid,
    tax_exempt boolean DEFAULT false,
    bank_name character varying(100),
    bank_account_name character varying(255),
    bank_account_number character varying(50),
    bank_routing_number character varying(50),
    bank_verified boolean DEFAULT false,
    bank_verified_at timestamp without time zone,
    bank_verified_by uuid,
    mpesa_phone character varying(20),
    mpesa_verified boolean DEFAULT false,
    mpesa_verified_at timestamp without time zone,
    mpesa_verified_by uuid,
    business_type character varying(50),
    business_registration_number character varying(100),
    business_registration_url character varying(500),
    business_registration_public_id character varying(200),
    business_address text,
    business_verified boolean DEFAULT false,
    business_verified_at timestamp without time zone,
    business_verified_by uuid,
    verification_status character varying(50) DEFAULT 'pending'::character varying,
    rejection_reason_details text,
    logo_public_id character varying(200),
    banner_public_id character varying(200),
    deleted_at timestamp without time zone,
    store_license_url character varying(500),
    store_license_public_id character varying(200),
    store_business_name character varying(255),
    store_business_address text,
    moderated_by uuid,
    moderated_at timestamp without time zone,
    moderation_notes text,
    moderator_id uuid,
    tagline character varying(200),
    cover_image_url character varying(500),
    support_hours character varying(255),
    timezone character varying(50),
    sub_categories jsonb DEFAULT '[]'::jsonb,
    currency character varying(3) DEFAULT 'USD'::character varying,
    language character varying(2) DEFAULT 'en'::character varying,
    return_policy jsonb,
    shipping_origin jsonb,
    view_count integer DEFAULT 0,
    published_at timestamp with time zone,
    suspended_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    country character varying(2),
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    type character varying(20),
    category character varying(30),
    total_products integer DEFAULT 0 NOT NULL,
    total_orders integer DEFAULT 0 NOT NULL,
    total_reviews integer DEFAULT 0 NOT NULL,
    average_rating numeric(3,2) DEFAULT 0 NOT NULL,
    suspended_reason text,
    CONSTRAINT check_business_type CHECK (((business_type)::text = ANY (ARRAY[('sole_proprietorship'::character varying)::text, ('llc'::character varying)::text, ('corporation'::character varying)::text, ('partnership'::character varying)::text, (NULL::character varying)::text]))),
    CONSTRAINT check_government_id_type CHECK (((government_id_type)::text = ANY (ARRAY[('passport'::character varying)::text, ('national_id'::character varying)::text, ('drivers_license'::character varying)::text, (NULL::character varying)::text]))),
    CONSTRAINT check_store_status CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('pending_approval'::character varying)::text, ('active'::character varying)::text, ('suspended'::character varying)::text, ('closed'::character varying)::text, ('rejected'::character varying)::text]))),
    CONSTRAINT check_verification_status CHECK (((verification_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('pending_id'::character varying)::text, ('pending_tax'::character varying)::text, ('pending_payout'::character varying)::text, ('pending_business'::character varying)::text, ('pending_all'::character varying)::text, ('verified'::character varying)::text, ('rejected'::character varying)::text])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    full_name text NOT NULL,
    role text DEFAULT 'customer'::text NOT NULL,
    store_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    token_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    avatar_url character varying(500),
    avatar_public_id character varying(200),
    phone character varying(20),
    phone_verified boolean DEFAULT false,
    legal_name character varying(255),
    date_of_birth date,
    country character varying(100),
    business_name character varying(100),
    business_type character varying(50),
    tax_id character varying(100),
    government_id_url character varying(500),
    government_id_public_id character varying(200),
    verification_status character varying(50) DEFAULT 'pending'::character varying,
    verified_at timestamp without time zone,
    rejection_reason text,
    CONSTRAINT check_business_type CHECK (((business_type)::text = ANY (ARRAY[('sole_proprietorship'::character varying)::text, ('llc'::character varying)::text, ('corporation'::character varying)::text, ('partnership'::character varying)::text, (NULL::character varying)::text]))),
    CONSTRAINT check_verification_status CHECK (((verification_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('verified'::character varying)::text, ('rejected'::character varying)::text]))),
    CONSTRAINT chk_users_role_store_id CHECK (((role = 'seller'::text) OR (store_id IS NULL))),
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['customer'::text, 'seller'::text, 'moderator'::text, 'admin'::text, 'super_admin'::text])))
);


--
-- Name: wishlists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wishlists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    product_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: invitation invitation_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.invitation
    ADD CONSTRAINT invitation_pkey PRIMARY KEY (id);


--
-- Name: jwks jwks_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.jwks
    ADD CONSTRAINT jwks_pkey PRIMARY KEY (id);


--
-- Name: member member_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.member
    ADD CONSTRAINT member_pkey PRIMARY KEY (id);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: organization organization_slug_key; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.organization
    ADD CONSTRAINT organization_slug_key UNIQUE (slug);


--
-- Name: project_config project_config_endpoint_id_key; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.project_config
    ADD CONSTRAINT project_config_endpoint_id_key UNIQUE (endpoint_id);


--
-- Name: project_config project_config_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.project_config
    ADD CONSTRAINT project_config_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: addresses addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_pkey PRIMARY KEY (id);


--
-- Name: attribute_definitions attribute_definitions_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_definitions
    ADD CONSTRAINT attribute_definitions_name_key UNIQUE (name);


--
-- Name: attribute_definitions attribute_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_definitions
    ADD CONSTRAINT attribute_definitions_pkey PRIMARY KEY (id);


--
-- Name: attribute_definitions attribute_definitions_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_definitions
    ADD CONSTRAINT attribute_definitions_slug_key UNIQUE (slug);


--
-- Name: attribute_options attribute_options_attribute_id_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_options
    ADD CONSTRAINT attribute_options_attribute_id_value_key UNIQUE (attribute_id, value);


--
-- Name: attribute_options attribute_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_options
    ADD CONSTRAINT attribute_options_pkey PRIMARY KEY (id);


--
-- Name: cart_items cart_items_cart_id_product_id_variant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT cart_items_cart_id_product_id_variant_id_key UNIQUE (cart_id, product_id, variant_id);


--
-- Name: cart_items cart_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT cart_items_pkey PRIMARY KEY (id);


--
-- Name: carts carts_guest_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts
    ADD CONSTRAINT carts_guest_token_key UNIQUE (guest_token);


--
-- Name: carts carts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts
    ADD CONSTRAINT carts_pkey PRIMARY KEY (id);


--
-- Name: carts carts_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts
    ADD CONSTRAINT carts_user_id_key UNIQUE (user_id);


--
-- Name: categories categories_parent_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_name_key UNIQUE (parent_id, name);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: categories categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_slug_key UNIQUE (slug);


--
-- Name: category_attributes category_attributes_category_id_attribute_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_attributes
    ADD CONSTRAINT category_attributes_category_id_attribute_id_key UNIQUE (category_id, attribute_id);


--
-- Name: category_attributes category_attributes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_attributes
    ADD CONSTRAINT category_attributes_pkey PRIMARY KEY (id);


--
-- Name: moderation_history moderation_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_history
    ADD CONSTRAINT moderation_history_pkey PRIMARY KEY (id);


--
-- Name: moderation_queue moderation_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_queue
    ADD CONSTRAINT moderation_queue_pkey PRIMARY KEY (id);


--
-- Name: mpesa_transactions mpesa_transactions_checkout_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mpesa_transactions
    ADD CONSTRAINT mpesa_transactions_checkout_request_id_key UNIQUE (checkout_request_id);


--
-- Name: mpesa_transactions mpesa_transactions_mpesa_receipt_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mpesa_transactions
    ADD CONSTRAINT mpesa_transactions_mpesa_receipt_key UNIQUE (mpesa_receipt);


--
-- Name: mpesa_transactions mpesa_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mpesa_transactions
    ADD CONSTRAINT mpesa_transactions_pkey PRIMARY KEY (id);


--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);


--
-- Name: orders orders_order_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_order_number_key UNIQUE (order_number);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: product_attribute_option_values product_attribute_option_valu_product_id_attribute_id_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_option_values
    ADD CONSTRAINT product_attribute_option_valu_product_id_attribute_id_value_key UNIQUE (product_id, attribute_id, value_option_id);


--
-- Name: product_attribute_option_values product_attribute_option_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_option_values
    ADD CONSTRAINT product_attribute_option_values_pkey PRIMARY KEY (id);


--
-- Name: product_attribute_values product_attribute_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_values
    ADD CONSTRAINT product_attribute_values_pkey PRIMARY KEY (id);


--
-- Name: product_attribute_values product_attribute_values_product_id_attribute_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_values
    ADD CONSTRAINT product_attribute_values_product_id_attribute_id_key UNIQUE (product_id, attribute_id);


--
-- Name: product_images product_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_pkey PRIMARY KEY (id);


--
-- Name: product_reviews product_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_pkey PRIMARY KEY (id);


--
-- Name: product_views product_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_views
    ADD CONSTRAINT product_views_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: products products_slug_store_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_slug_store_unique UNIQUE (slug, store_id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: returns returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.returns
    ADD CONSTRAINT returns_pkey PRIMARY KEY (id);


--
-- Name: sellers sellers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sellers
    ADD CONSTRAINT sellers_pkey PRIMARY KEY (id);


--
-- Name: sellers sellers_store_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sellers
    ADD CONSTRAINT sellers_store_name_key UNIQUE (store_name);


--
-- Name: sellers sellers_store_url_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sellers
    ADD CONSTRAINT sellers_store_url_slug_key UNIQUE (store_url_slug);


--
-- Name: sellers sellers_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sellers
    ADD CONSTRAINT sellers_user_id_key UNIQUE (user_id);


--
-- Name: store_reviews store_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_reviews
    ADD CONSTRAINT store_reviews_pkey PRIMARY KEY (id);


--
-- Name: stores stores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_pkey PRIMARY KEY (id);


--
-- Name: stores stores_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_slug_key UNIQUE (slug);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: wishlists wishlists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlists
    ADD CONSTRAINT wishlists_pkey PRIMARY KEY (id);


--
-- Name: wishlists wishlists_user_id_product_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlists
    ADD CONSTRAINT wishlists_user_id_product_id_key UNIQUE (user_id, product_id);


--
-- Name: account_userId_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX "account_userId_idx" ON neon_auth.account USING btree ("userId");


--
-- Name: invitation_email_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX invitation_email_idx ON neon_auth.invitation USING btree (email);


--
-- Name: invitation_organizationId_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX "invitation_organizationId_idx" ON neon_auth.invitation USING btree ("organizationId");


--
-- Name: member_organizationId_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX "member_organizationId_idx" ON neon_auth.member USING btree ("organizationId");


--
-- Name: member_userId_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX "member_userId_idx" ON neon_auth.member USING btree ("userId");


--
-- Name: organization_slug_uidx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE UNIQUE INDEX organization_slug_uidx ON neon_auth.organization USING btree (slug);


--
-- Name: session_userId_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX "session_userId_idx" ON neon_auth.session USING btree ("userId");


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX verification_identifier_idx ON neon_auth.verification USING btree (identifier);


--
-- Name: categories_is_featured_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_is_featured_idx ON public.categories USING btree (is_featured) WHERE (is_featured = true);


--
-- Name: categories_is_leaf_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_is_leaf_idx ON public.categories USING btree (is_leaf);


--
-- Name: categories_parent_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_parent_sort_idx ON public.categories USING btree (parent_id, sort_order);


--
-- Name: categories_path_gist_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_path_gist_idx ON public.categories USING gist (path);


--
-- Name: categories_root_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX categories_root_name_unique ON public.categories USING btree (name) WHERE (parent_id IS NULL);


--
-- Name: categories_seo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_seo_gin_idx ON public.categories USING gin (seo);


--
-- Name: categories_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_status_idx ON public.categories USING btree (status);


--
-- Name: categories_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_type_idx ON public.categories USING btree (type);


--
-- Name: idx_addresses_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_addresses_user_id ON public.addresses USING btree (user_id, created_at DESC);


--
-- Name: idx_cart_items_cart_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cart_items_cart_id ON public.cart_items USING btree (cart_id);


--
-- Name: idx_carts_guest_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_carts_guest_token ON public.carts USING btree (guest_token) WHERE (guest_token IS NOT NULL);


--
-- Name: idx_carts_last_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_carts_last_activity ON public.carts USING btree (last_activity_at);


--
-- Name: idx_carts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_carts_user_id ON public.carts USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_categories_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_is_active ON public.categories USING btree (is_active);


--
-- Name: idx_categories_parent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_parent_id ON public.categories USING btree (parent_id);


--
-- Name: idx_categories_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_slug ON public.categories USING btree (slug);


--
-- Name: idx_categories_sort_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_sort_order ON public.categories USING btree (sort_order);


--
-- Name: idx_category_attributes_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_category_attributes_category ON public.category_attributes USING btree (category_id);


--
-- Name: idx_moderation_history_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_history_created_at ON public.moderation_history USING btree (created_at DESC);


--
-- Name: idx_moderation_history_moderator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_history_moderator ON public.moderation_history USING btree (moderator_id);


--
-- Name: idx_moderation_history_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_history_target ON public.moderation_history USING btree (target_type, target_id);


--
-- Name: idx_moderation_history_target_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_history_target_type ON public.moderation_history USING btree (target_type);


--
-- Name: idx_moderation_queue_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_queue_priority ON public.moderation_queue USING btree (priority);


--
-- Name: idx_moderation_queue_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_queue_status ON public.moderation_queue USING btree (status);


--
-- Name: idx_moderation_queue_submitted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_queue_submitted_at ON public.moderation_queue USING btree (submitted_at);


--
-- Name: idx_moderation_queue_submitted_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_queue_submitted_by ON public.moderation_queue USING btree (submitted_by);


--
-- Name: idx_moderation_queue_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_queue_target ON public.moderation_queue USING btree (target_type, target_id);


--
-- Name: idx_moderation_queue_target_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_queue_target_type ON public.moderation_queue USING btree (target_type);


--
-- Name: idx_mpesa_checkout_request_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mpesa_checkout_request_id ON public.mpesa_transactions USING btree (checkout_request_id) WHERE (checkout_request_id IS NOT NULL);


--
-- Name: idx_mpesa_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mpesa_order_id ON public.mpesa_transactions USING btree (order_id);


--
-- Name: idx_mpesa_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mpesa_status ON public.mpesa_transactions USING btree (status);


--
-- Name: idx_order_items_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_order_id ON public.order_items USING btree (order_id);


--
-- Name: idx_order_items_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_product_id ON public.order_items USING btree (product_id);


--
-- Name: idx_orders_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_created_at ON public.orders USING btree (created_at DESC);


--
-- Name: idx_orders_fulfillment_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_fulfillment_status ON public.orders USING btree (fulfillment_status);


--
-- Name: idx_orders_order_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_order_number ON public.orders USING btree (order_number);


--
-- Name: idx_orders_payment_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_payment_group ON public.orders USING btree (payment_group_id) WHERE (payment_group_id IS NOT NULL);


--
-- Name: idx_orders_payment_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_payment_status ON public.orders USING btree (payment_status);


--
-- Name: idx_orders_placed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_placed_at ON public.orders USING btree (placed_at DESC);


--
-- Name: idx_orders_seller_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_seller_id ON public.orders USING btree (seller_id);


--
-- Name: idx_orders_seller_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_seller_status ON public.orders USING btree (seller_id, status);


--
-- Name: idx_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_status ON public.orders USING btree (status);


--
-- Name: idx_orders_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_status_created ON public.orders USING btree (status, created_at DESC);


--
-- Name: idx_orders_store_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_store_id ON public.orders USING btree (store_id);


--
-- Name: idx_orders_store_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_store_status ON public.orders USING btree (store_id, status);


--
-- Name: idx_orders_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_user_id ON public.orders USING btree (user_id);


--
-- Name: idx_orders_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_user_status ON public.orders USING btree (user_id, status);


--
-- Name: idx_password_reset_tokens_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_reset_tokens_hash ON public.password_reset_tokens USING btree (token_hash);


--
-- Name: idx_password_reset_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_reset_tokens_user_id ON public.password_reset_tokens USING btree (user_id);


--
-- Name: idx_pav_attribute; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pav_attribute ON public.product_attribute_values USING btree (attribute_id);


--
-- Name: idx_pav_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pav_number ON public.product_attribute_values USING btree (attribute_id, value_number) WHERE (value_number IS NOT NULL);


--
-- Name: idx_pav_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pav_product ON public.product_attribute_values USING btree (product_id);


--
-- Name: idx_product_images_one_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_product_images_one_primary ON public.product_images USING btree (product_id) WHERE (is_primary = true);


--
-- Name: idx_product_images_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_images_primary ON public.product_images USING btree (product_id) WHERE (is_primary = true);


--
-- Name: idx_product_images_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_images_product_id ON public.product_images USING btree (product_id);


--
-- Name: idx_product_reviews_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_reviews_created_at ON public.product_reviews USING btree (created_at DESC);


--
-- Name: idx_product_reviews_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_reviews_product_id ON public.product_reviews USING btree (product_id);


--
-- Name: idx_product_reviews_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_reviews_status ON public.product_reviews USING btree (status);


--
-- Name: idx_product_reviews_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_reviews_user_id ON public.product_reviews USING btree (user_id);


--
-- Name: idx_product_views_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_views_created_at ON public.product_views USING btree (created_at);


--
-- Name: idx_product_views_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_views_product_id ON public.product_views USING btree (product_id);


--
-- Name: idx_product_views_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_views_user_id ON public.product_views USING btree (user_id);


--
-- Name: idx_products_active_not_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_active_not_deleted ON public.products USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_products_average_rating; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_average_rating ON public.products USING btree (average_rating);


--
-- Name: idx_products_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_category_id ON public.products USING btree (category_id);


--
-- Name: idx_products_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_created_at ON public.products USING btree (created_at);


--
-- Name: idx_products_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_is_active ON public.products USING btree (is_active);


--
-- Name: idx_products_moderator_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_moderator_queue ON public.products USING btree (created_at) WHERE ((deleted_at IS NULL) AND ((status)::text = 'pending'::text));


--
-- Name: idx_products_pending_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_pending_queue ON public.products USING btree (created_at) WHERE ((deleted_at IS NULL) AND ((status)::text = 'pending'::text));


--
-- Name: idx_products_price; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_price ON public.products USING btree (price);


--
-- Name: idx_products_public_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_public_active ON public.products USING btree (created_at DESC) WHERE ((deleted_at IS NULL) AND ((status)::text = 'active'::text));


--
-- Name: idx_products_seller_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_seller_id ON public.products USING btree (seller_id);


--
-- Name: idx_products_seller_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_seller_live ON public.products USING btree (seller_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_products_seo_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_seo_gin ON public.products USING gin (seo);


--
-- Name: idx_products_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_slug ON public.products USING btree (slug);


--
-- Name: idx_products_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_status ON public.products USING btree (status);


--
-- Name: idx_products_store_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_store_id ON public.products USING btree (store_id);


--
-- Name: idx_products_store_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_store_live ON public.products USING btree (store_id, created_at DESC) WHERE ((deleted_at IS NULL) AND (is_active = true) AND ((status)::text = 'active'::text));


--
-- Name: idx_products_tags_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_tags_gin ON public.products USING gin (tags);


--
-- Name: idx_products_unapproved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_unapproved ON public.products USING btree (created_at DESC) WHERE ((deleted_at IS NULL) AND (is_approved = false));


--
-- Name: idx_products_variant_attribute_ids; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_variant_attribute_ids ON public.products USING gin (variant_attribute_ids);


--
-- Name: idx_refresh_tokens_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_active ON public.refresh_tokens USING btree (user_id, expires_at) WHERE (revoked_at IS NULL);


--
-- Name: idx_refresh_tokens_replaced_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_replaced_by ON public.refresh_tokens USING btree (replaced_by);


--
-- Name: idx_refresh_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_user_id ON public.refresh_tokens USING btree (user_id);


--
-- Name: idx_returns_order_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_returns_order_item_id ON public.returns USING btree (order_item_id);


--
-- Name: idx_returns_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_returns_user_id ON public.returns USING btree (user_id);


--
-- Name: idx_seller_country_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seller_country_status ON public.sellers USING btree (country, verification_status);


--
-- Name: idx_seller_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seller_created_at ON public.sellers USING btree (created_at);


--
-- Name: idx_seller_rating; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seller_rating ON public.sellers USING btree (rating);


--
-- Name: idx_seller_rating_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seller_rating_country ON public.sellers USING btree (rating DESC, country) WHERE (((verification_status)::text = 'verified'::text) AND (suspended_at IS NULL));


--
-- Name: idx_seller_store_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seller_store_name ON public.sellers USING btree (store_name);


--
-- Name: idx_seller_store_name_partial; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seller_store_name_partial ON public.sellers USING btree (store_name) WHERE ((verification_status)::text = 'verified'::text);


--
-- Name: idx_seller_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seller_user_id ON public.sellers USING btree (user_id);


--
-- Name: idx_seller_verification_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seller_verification_status ON public.sellers USING btree (verification_status);


--
-- Name: idx_sellers_business_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sellers_business_name ON public.sellers USING btree (business_name);


--
-- Name: idx_sellers_kyc_expiry_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sellers_kyc_expiry_date ON public.sellers USING btree (kyc_expiry_date) WHERE (kyc_expiry_date IS NOT NULL);


--
-- Name: idx_sellers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sellers_status ON public.sellers USING btree (status);


--
-- Name: idx_sellers_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sellers_user_id ON public.sellers USING btree (user_id);


--
-- Name: idx_sellers_verification_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sellers_verification_status ON public.sellers USING btree (verification_status);


--
-- Name: idx_store_reviews_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_store_reviews_created_at ON public.store_reviews USING btree (created_at DESC);


--
-- Name: idx_store_reviews_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_store_reviews_status ON public.store_reviews USING btree (status);


--
-- Name: idx_store_reviews_store_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_store_reviews_store_id ON public.store_reviews USING btree (store_id);


--
-- Name: idx_store_reviews_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_store_reviews_user_id ON public.store_reviews USING btree (user_id);


--
-- Name: idx_stores_bank_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stores_bank_account ON public.stores USING btree (bank_account_number);


--
-- Name: idx_stores_business_registration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stores_business_registration ON public.stores USING btree (business_registration_number);


--
-- Name: idx_stores_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stores_deleted_at ON public.stores USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);


--
-- Name: idx_stores_government_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stores_government_id ON public.stores USING btree (government_id_number);


--
-- Name: idx_stores_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stores_is_active ON public.stores USING btree (is_active);


--
-- Name: idx_stores_is_approved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stores_is_approved ON public.stores USING btree (is_approved);


--
-- Name: idx_stores_kra_pin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stores_kra_pin ON public.stores USING btree (kra_pin);


--
-- Name: idx_stores_legal_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stores_legal_name ON public.stores USING btree (legal_name);


--
-- Name: idx_stores_seller_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stores_seller_id ON public.stores USING btree (seller_id);


--
-- Name: idx_stores_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stores_slug ON public.stores USING btree (slug);


--
-- Name: idx_stores_verification_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stores_verification_status ON public.stores USING btree (verification_status);


--
-- Name: idx_users_business_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_business_name ON public.users USING btree (business_name);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_users_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_phone ON public.users USING btree (phone);


--
-- Name: idx_users_store_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_store_id ON public.users USING btree (store_id) WHERE (store_id IS NOT NULL);


--
-- Name: idx_users_verification_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_verification_status ON public.users USING btree (verification_status);


--
-- Name: idx_wishlists_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wishlists_product_id ON public.wishlists USING btree (product_id);


--
-- Name: idx_wishlists_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wishlists_user_id ON public.wishlists USING btree (user_id, created_at DESC);


--
-- Name: categories category_slug_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER category_slug_trigger BEFORE INSERT OR UPDATE OF name ON public.categories FOR EACH ROW EXECUTE FUNCTION public.set_category_slug();


--
-- Name: stores store_slug_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER store_slug_trigger BEFORE INSERT OR UPDATE OF name ON public.stores FOR EACH ROW EXECUTE FUNCTION public.set_store_slug();


--
-- Name: users trg_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES neon_auth."user"(id) ON DELETE CASCADE;


--
-- Name: invitation invitation_inviterId_fkey; Type: FK CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.invitation
    ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES neon_auth."user"(id) ON DELETE CASCADE;


--
-- Name: invitation invitation_organizationId_fkey; Type: FK CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.invitation
    ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES neon_auth.organization(id) ON DELETE CASCADE;


--
-- Name: member member_organizationId_fkey; Type: FK CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.member
    ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES neon_auth.organization(id) ON DELETE CASCADE;


--
-- Name: member member_userId_fkey; Type: FK CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.member
    ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES neon_auth."user"(id) ON DELETE CASCADE;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES neon_auth."user"(id) ON DELETE CASCADE;


--
-- Name: addresses addresses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: attribute_options attribute_options_attribute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_options
    ADD CONSTRAINT attribute_options_attribute_id_fkey FOREIGN KEY (attribute_id) REFERENCES public.attribute_definitions(id) ON DELETE CASCADE;


--
-- Name: cart_items cart_items_cart_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT cart_items_cart_id_fkey FOREIGN KEY (cart_id) REFERENCES public.carts(id) ON DELETE CASCADE;


--
-- Name: cart_items cart_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT cart_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: carts carts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts
    ADD CONSTRAINT carts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: categories categories_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: categories categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.categories(id) ON DELETE CASCADE;


--
-- Name: category_attributes category_attributes_attribute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_attributes
    ADD CONSTRAINT category_attributes_attribute_id_fkey FOREIGN KEY (attribute_id) REFERENCES public.attribute_definitions(id) ON DELETE CASCADE;


--
-- Name: category_attributes category_attributes_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_attributes
    ADD CONSTRAINT category_attributes_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;


--
-- Name: moderation_history moderation_history_moderator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_history
    ADD CONSTRAINT moderation_history_moderator_id_fkey FOREIGN KEY (moderator_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: moderation_queue moderation_queue_moderated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_queue
    ADD CONSTRAINT moderation_queue_moderated_by_fkey FOREIGN KEY (moderated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: moderation_queue moderation_queue_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_queue
    ADD CONSTRAINT moderation_queue_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: mpesa_transactions mpesa_transactions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mpesa_transactions
    ADD CONSTRAINT mpesa_transactions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: orders orders_seller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES public.sellers(id) ON DELETE CASCADE;


--
-- Name: orders orders_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE CASCADE;


--
-- Name: orders orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: product_attribute_option_values product_attribute_option_values_attribute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_option_values
    ADD CONSTRAINT product_attribute_option_values_attribute_id_fkey FOREIGN KEY (attribute_id) REFERENCES public.attribute_definitions(id) ON DELETE CASCADE;


--
-- Name: product_attribute_option_values product_attribute_option_values_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_option_values
    ADD CONSTRAINT product_attribute_option_values_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_attribute_option_values product_attribute_option_values_value_option_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_option_values
    ADD CONSTRAINT product_attribute_option_values_value_option_id_fkey FOREIGN KEY (value_option_id) REFERENCES public.attribute_options(id);


--
-- Name: product_attribute_values product_attribute_values_attribute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_values
    ADD CONSTRAINT product_attribute_values_attribute_id_fkey FOREIGN KEY (attribute_id) REFERENCES public.attribute_definitions(id) ON DELETE CASCADE;


--
-- Name: product_attribute_values product_attribute_values_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_values
    ADD CONSTRAINT product_attribute_values_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_attribute_values product_attribute_values_value_option_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_values
    ADD CONSTRAINT product_attribute_values_value_option_id_fkey FOREIGN KEY (value_option_id) REFERENCES public.attribute_options(id);


--
-- Name: product_images product_images_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_reviews product_reviews_moderated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_moderated_by_fkey FOREIGN KEY (moderated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: product_reviews product_reviews_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: product_reviews product_reviews_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_reviews product_reviews_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: product_views product_views_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_views
    ADD CONSTRAINT product_views_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_views product_views_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_views
    ADD CONSTRAINT product_views_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: products products_seller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES public.sellers(id) ON DELETE CASCADE;


--
-- Name: products products_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_replaced_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_replaced_by_fkey FOREIGN KEY (replaced_by) REFERENCES public.refresh_tokens(id);


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: returns returns_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.returns
    ADD CONSTRAINT returns_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.order_items(id) ON DELETE SET NULL;


--
-- Name: returns returns_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.returns
    ADD CONSTRAINT returns_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sellers sellers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sellers
    ADD CONSTRAINT sellers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: store_reviews store_reviews_moderated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_reviews
    ADD CONSTRAINT store_reviews_moderated_by_fkey FOREIGN KEY (moderated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: store_reviews store_reviews_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_reviews
    ADD CONSTRAINT store_reviews_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: store_reviews store_reviews_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_reviews
    ADD CONSTRAINT store_reviews_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE CASCADE;


--
-- Name: store_reviews store_reviews_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_reviews
    ADD CONSTRAINT store_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: stores stores_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: stores stores_bank_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_bank_verified_by_fkey FOREIGN KEY (bank_verified_by) REFERENCES public.users(id);


--
-- Name: stores stores_business_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_business_verified_by_fkey FOREIGN KEY (business_verified_by) REFERENCES public.users(id);


--
-- Name: stores stores_id_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_id_verified_by_fkey FOREIGN KEY (id_verified_by) REFERENCES public.users(id);


--
-- Name: stores stores_moderated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_moderated_by_fkey FOREIGN KEY (moderated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: stores stores_moderator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_moderator_id_fkey FOREIGN KEY (moderator_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: stores stores_mpesa_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_mpesa_verified_by_fkey FOREIGN KEY (mpesa_verified_by) REFERENCES public.users(id);


--
-- Name: stores stores_tax_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_tax_verified_by_fkey FOREIGN KEY (tax_verified_by) REFERENCES public.users(id);


--
-- Name: wishlists wishlists_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlists
    ADD CONSTRAINT wishlists_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: wishlists wishlists_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wishlists
    ADD CONSTRAINT wishlists_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


