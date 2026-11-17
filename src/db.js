import pg from "pg";
import { env } from "./config.js";

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

pool.on("error", (err) => {
  console.error("[db] erro em conexão ociosa:", err.message);
});