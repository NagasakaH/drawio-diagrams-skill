-- ============================================================================
-- E コマース基盤スキーマ (PostgreSQL)
-- drawio-er-skill デモ用の実務的なサンプル DDL
-- ============================================================================

CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           varchar(255) NOT NULL UNIQUE,
    display_name    varchar(100) NOT NULL,
    password_hash   varchar(255) NOT NULL,
    phone           varchar(20),
    status          varchar(20) NOT NULL DEFAULT 'active',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    label           varchar(50) NOT NULL DEFAULT 'home',
    postal_code     varchar(8) NOT NULL,
    prefecture      varchar(20) NOT NULL,
    city            varchar(50) NOT NULL,
    street          varchar(255) NOT NULL,
    is_default      boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_address_per_user UNIQUE (user_id, label)
);

CREATE TABLE categories (
    id              serial PRIMARY KEY,
    slug            varchar(64) NOT NULL UNIQUE,
    name            varchar(100) NOT NULL,
    parent_id       integer REFERENCES categories (id) ON DELETE SET NULL,
    sort_order      integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id              bigserial PRIMARY KEY,
    sku             varchar(64) NOT NULL UNIQUE,
    category_id     integer NOT NULL,
    name            varchar(200) NOT NULL,
    description     text,
    price_cents     integer NOT NULL,
    stock_quantity  integer NOT NULL DEFAULT 0,
    status          varchar(20) NOT NULL DEFAULT 'draft',
    released_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_products_category
        FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT
);

CREATE TABLE orders (
    id                    bigserial PRIMARY KEY,
    user_id               uuid NOT NULL,
    shipping_address_id   uuid REFERENCES addresses (id) ON DELETE SET NULL,
    order_no              varchar(32) NOT NULL UNIQUE,
    status                varchar(20) NOT NULL DEFAULT 'pending',
    subtotal_cents        integer NOT NULL DEFAULT 0,
    shipping_cents        integer NOT NULL DEFAULT 0,
    total_cents           integer NOT NULL,
    placed_at             timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_orders_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE TABLE order_items (
    id              bigserial PRIMARY KEY,
    order_id        bigint NOT NULL,
    product_id      bigint NOT NULL,
    quantity        integer NOT NULL DEFAULT 1,
    unit_price_cents integer NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_order_items_order
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT fk_order_items_product
        FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
    CONSTRAINT uq_order_item UNIQUE (order_id, product_id)
);

CREATE TABLE payments (
    id              bigserial PRIMARY KEY,
    order_id        bigint NOT NULL,
    method          varchar(30) NOT NULL,
    provider_charge_id varchar(120) UNIQUE,
    amount_cents    integer NOT NULL,
    status          varchar(20) NOT NULL DEFAULT 'initiated',
    paid_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payments
    ADD CONSTRAINT fk_payments_order
    FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT;
