export const port = Number(process.env.PORT ?? 8080);
export const { DATABASE_URL, FEATURE_REPORTS = "false" } = process.env;
