import type { Knex } from "knex";

const config: { [key: string]: Knex.Config } = {
    development: {
        client: "sqlite3",
        connection: {
            filename: "./dev.sqlite3"
        },
        useNullAsDefault: true,
        migrations: {
            directory: "./migrations",
            extension: "ts"
        }
    },
    production: {
        client: "sqlite3",
        connection: {
            filename: "./prod.sqlite3"
        },
        useNullAsDefault: true,
        migrations: {
            directory: "./migrations",
            extension: "ts"
        }
    }
};

export default config;
