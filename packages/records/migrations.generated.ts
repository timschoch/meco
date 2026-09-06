// Generated from drizzle/ by migrations.ts. Do not edit.
//
// The SQL has to travel inside the bundle: the gateway's runtime image copies
// `dist/bundle` alone, so there is no folder to read it from. Regenerate with
// `pnpm --filter @meco/records migrations`.

/** One committed migration, as `migrate()` applies it and `/health` counts it. */
export interface EmbeddedMigration {
  /** The file's name without `.sql`, and its primary key in the applied table. */
  readonly tag: string;
  /** SHA-256 of the whole file, so an edited migration is a loud failure. */
  readonly hash: string;
  /** The file split on drizzle's statement breakpoints, in order. */
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly EmbeddedMigration[] = [
  {
    "tag": "0000_the_nine_tables",
    "hash": "c5ec0ba4ce07392cd6f5885573c3f1440f2379b4a0e014e5d8fcd79c99802a86",
    "statements": [
      "CREATE TABLE \"annotations\" (\n\t\"hash\" text PRIMARY KEY NOT NULL,\n\t\"schema\" integer NOT NULL,\n\t\"produced_by\" jsonb NOT NULL,\n\t\"annotation\" jsonb NOT NULL,\n\t\"annotated_at\" timestamp with time zone DEFAULT now() NOT NULL\n);",
      "CREATE TABLE \"brands\" (\n\t\"id\" text PRIMARY KEY NOT NULL,\n\t\"name\" text NOT NULL,\n\t\"created_at\" timestamp with time zone DEFAULT now() NOT NULL\n);",
      "CREATE TABLE \"callers\" (\n\t\"id\" text PRIMARY KEY NOT NULL,\n\t\"name\" text NOT NULL,\n\t\"key_hash\" text NOT NULL,\n\t\"brands\" text[] NOT NULL,\n\t\"created_at\" timestamp with time zone DEFAULT now() NOT NULL,\n\tCONSTRAINT \"callers_key_hash_unique\" UNIQUE(\"key_hash\")\n);",
      "CREATE TABLE \"calls\" (\n\t\"id\" text PRIMARY KEY NOT NULL,\n\t\"caller_id\" text NOT NULL,\n\t\"brand\" text NOT NULL,\n\t\"kind\" text NOT NULL,\n\t\"source_hash\" text,\n\t\"request\" jsonb,\n\t\"framing\" jsonb,\n\t\"matches\" jsonb,\n\t\"redactions\" jsonb,\n\t\"steps\" jsonb,\n\t\"cost\" jsonb,\n\t\"error\" jsonb,\n\t\"status\" text NOT NULL,\n\t\"started_at\" timestamp with time zone DEFAULT now() NOT NULL,\n\t\"duration_ms\" integer\n);",
      "CREATE TABLE \"files\" (\n\t\"hash\" text PRIMARY KEY NOT NULL,\n\t\"mime\" text NOT NULL,\n\t\"width\" integer NOT NULL,\n\t\"height\" integer NOT NULL,\n\t\"bytes\" integer NOT NULL,\n\t\"store_key\" text NOT NULL,\n\t\"first_seen_at\" timestamp with time zone DEFAULT now() NOT NULL\n);",
      "CREATE TABLE \"outputs\" (\n\t\"brand\" text NOT NULL,\n\t\"store_key\" text NOT NULL,\n\t\"call_id\" text NOT NULL,\n\t\"kind\" text NOT NULL,\n\t\"placement\" text,\n\t\"request_hash\" text NOT NULL,\n\t\"created_at\" timestamp with time zone DEFAULT now() NOT NULL,\n\tCONSTRAINT \"outputs_brand_store_key_pk\" PRIMARY KEY(\"brand\",\"store_key\")\n);",
      "CREATE TABLE \"people\" (\n\t\"id\" text PRIMARY KEY NOT NULL,\n\t\"brand\" text NOT NULL,\n\t\"name\" text NOT NULL,\n\t\"created_at\" timestamp with time zone DEFAULT now() NOT NULL\n);",
      "CREATE TABLE \"reference_photos\" (\n\t\"id\" text PRIMARY KEY NOT NULL,\n\t\"person_id\" text NOT NULL,\n\t\"brand\" text NOT NULL,\n\t\"hash\" text NOT NULL,\n\t\"store_key\" text NOT NULL,\n\t\"region_id\" text NOT NULL,\n\t\"face_print\" jsonb NOT NULL,\n\t\"consent_at\" timestamp with time zone,\n\t\"created_at\" timestamp with time zone DEFAULT now() NOT NULL\n);",
      "CREATE TABLE \"sources\" (\n\t\"brand\" text NOT NULL,\n\t\"hash\" text NOT NULL,\n\t\"first_used_at\" timestamp with time zone DEFAULT now() NOT NULL,\n\tCONSTRAINT \"sources_brand_hash_pk\" PRIMARY KEY(\"brand\",\"hash\")\n);",
      "ALTER TABLE \"annotations\" ADD CONSTRAINT \"annotations_hash_files_hash_fk\" FOREIGN KEY (\"hash\") REFERENCES \"public\".\"files\"(\"hash\") ON DELETE cascade ON UPDATE no action;",
      "ALTER TABLE \"calls\" ADD CONSTRAINT \"calls_caller_id_callers_id_fk\" FOREIGN KEY (\"caller_id\") REFERENCES \"public\".\"callers\"(\"id\") ON DELETE no action ON UPDATE no action;",
      "ALTER TABLE \"calls\" ADD CONSTRAINT \"calls_brand_brands_id_fk\" FOREIGN KEY (\"brand\") REFERENCES \"public\".\"brands\"(\"id\") ON DELETE no action ON UPDATE no action;",
      "ALTER TABLE \"outputs\" ADD CONSTRAINT \"outputs_brand_brands_id_fk\" FOREIGN KEY (\"brand\") REFERENCES \"public\".\"brands\"(\"id\") ON DELETE no action ON UPDATE no action;",
      "ALTER TABLE \"outputs\" ADD CONSTRAINT \"outputs_call_id_calls_id_fk\" FOREIGN KEY (\"call_id\") REFERENCES \"public\".\"calls\"(\"id\") ON DELETE no action ON UPDATE no action;",
      "ALTER TABLE \"people\" ADD CONSTRAINT \"people_brand_brands_id_fk\" FOREIGN KEY (\"brand\") REFERENCES \"public\".\"brands\"(\"id\") ON DELETE no action ON UPDATE no action;",
      "ALTER TABLE \"reference_photos\" ADD CONSTRAINT \"reference_photos_person_id_people_id_fk\" FOREIGN KEY (\"person_id\") REFERENCES \"public\".\"people\"(\"id\") ON DELETE cascade ON UPDATE no action;",
      "ALTER TABLE \"reference_photos\" ADD CONSTRAINT \"reference_photos_brand_brands_id_fk\" FOREIGN KEY (\"brand\") REFERENCES \"public\".\"brands\"(\"id\") ON DELETE no action ON UPDATE no action;",
      "ALTER TABLE \"reference_photos\" ADD CONSTRAINT \"reference_photos_hash_files_hash_fk\" FOREIGN KEY (\"hash\") REFERENCES \"public\".\"files\"(\"hash\") ON DELETE no action ON UPDATE no action;",
      "ALTER TABLE \"sources\" ADD CONSTRAINT \"sources_brand_brands_id_fk\" FOREIGN KEY (\"brand\") REFERENCES \"public\".\"brands\"(\"id\") ON DELETE no action ON UPDATE no action;",
      "ALTER TABLE \"sources\" ADD CONSTRAINT \"sources_hash_files_hash_fk\" FOREIGN KEY (\"hash\") REFERENCES \"public\".\"files\"(\"hash\") ON DELETE no action ON UPDATE no action;",
      "CREATE INDEX \"calls_brand_started_at_index\" ON \"calls\" USING btree (\"brand\",\"started_at\");",
      "CREATE INDEX \"calls_source_hash_index\" ON \"calls\" USING btree (\"source_hash\");",
      "CREATE INDEX \"outputs_brand_request_hash_index\" ON \"outputs\" USING btree (\"brand\",\"request_hash\");",
      "CREATE INDEX \"outputs_store_key_index\" ON \"outputs\" USING btree (\"store_key\");",
      "CREATE INDEX \"outputs_created_at_store_key_index\" ON \"outputs\" USING btree (\"created_at\",\"store_key\");",
      "CREATE INDEX \"people_brand_index\" ON \"people\" USING btree (\"brand\");",
      "CREATE INDEX \"reference_photos_person_id_index\" ON \"reference_photos\" USING btree (\"person_id\");",
      "CREATE INDEX \"reference_photos_hash_index\" ON \"reference_photos\" USING btree (\"hash\");",
      "CREATE INDEX \"sources_hash_index\" ON \"sources\" USING btree (\"hash\");"
    ]
  }
];
