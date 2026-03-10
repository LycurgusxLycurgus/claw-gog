export type ErrorResponse = {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
};

export function jsonError(status: number, code: string, message: string, details?: Record<string, unknown>) {
  return new Response(JSON.stringify({ status, code, message, details }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
