export const env = {
  port: Number(process.env.PORT ?? 3001),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/be',
  isTest: (process.env.NODE_ENV ?? 'development') === 'test',
};
