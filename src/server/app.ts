import express from "express";

export function createApp(): express.Express {
  const app = express();

  // Kept separate from the MCP route because container probes issue GET and the
  // MCP endpoint only answers POST.
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  return app;
}
