import type { NextFunction, Request, Response } from "express";

export interface Session {
  userId: string;
  role: "CUSTOMER" | "ADMIN";
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const session = (req as Request & { session?: Session }).session;
  if (!session) {
    res.status(401).json({ error: "login required" });
    return;
  }
  next();
}

export function requireRole(role: Session["role"]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = (req as Request & { session?: Session }).session;
    if (!session || session.role !== role) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}
