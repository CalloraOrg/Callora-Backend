import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("users", (table) => {
        table.increments("id").primary();
        table.string("stellar_address").notNullable().unique();
        table.timestamps(true, true); // creates created_at and updated_at
    });

    await knex.schema.createTable("developers", (table) => {
        table.increments("id").primary();
        table.string("user_id").notNullable();
        table.string("name").notNullable();
        table.timestamps(true, true);
        table.foreign("user_id").references("stellar_address").inTable("users").onDelete("CASCADE");
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("developers");
    await knex.schema.dropTableIfExists("users");
}
