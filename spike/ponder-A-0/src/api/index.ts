// Minimal API for spike — just the health endpoints Ponder wants.
import { Hono } from "hono";
import { db } from "ponder:api";
import schema from "ponder:schema";
import { graphql } from "ponder";

const app = new Hono();

// Default Ponder graphql at /graphql
app.use("/graphql", graphql({ db, schema }));

export default app;
