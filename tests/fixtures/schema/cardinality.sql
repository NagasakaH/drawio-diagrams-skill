-- 基数推定の境界値を固定的に確かめるための最小スキーマ。
-- 1) profiles        : user_id が単独 PK かつ NOT NULL FK    -> 1:0..1
-- 2) user_settings   : user_id が UNIQUE かつ NULL 許容 FK   -> 0..1:0..1
-- 3) order_lines     : 複合主キー (order_id, line_no) の一部だけを参照する。
--                      列集合全体は UNIQUE でないので多数側に残る  -> 1:0..N
-- 4) product_tags    : tag_id が UNIQUE かつ NULL 許容 FK    -> 0..1:0..1
-- 5) orders          : user_id が NOT NULL FK・UNIQUE なし   -> 1:0..N
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id)
);

CREATE TABLE profiles (
  user_id BIGINT NOT NULL PRIMARY KEY REFERENCES users (id),
  bio TEXT
);

CREATE TABLE user_settings (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT UNIQUE REFERENCES users (id)
);

CREATE TABLE order_lines (
  order_id BIGINT NOT NULL REFERENCES orders (id),
  line_no INTEGER NOT NULL,
  amount NUMERIC NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE tags (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE product_tags (
  product_id BIGINT NOT NULL,
  tag_id BIGINT UNIQUE REFERENCES tags (id)
);
