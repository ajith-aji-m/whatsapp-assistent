// Side-effect-only module: loads .env into process.env.
// Imported by config.js (and anything else that needs process.env) so that
// env vars are guaranteed to be loaded before they're read, regardless of
// import order — ES module imports execute before the importing file's own code.
import dotenv from "dotenv";

dotenv.config();
