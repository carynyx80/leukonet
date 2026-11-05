/** Backend base URL. Empty when the dashboard is served by the backend itself. */
export const API = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
