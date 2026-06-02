function textHeaders(): Headers {
  const headers = new Headers();
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("cache-control", "no-store, max-age=0");
  return headers;
}

function message(status: string): string {
  if (status === "success") {
    return [
      "Payment complete",
      "",
      "Your payment was accepted.",
      "Return to Garage CRM and the Billing page will refresh.",
      "",
      "You can close this browser tab.",
    ].join("\n");
  }

  if (status === "cancelled") {
    return [
      "Checkout cancelled",
      "",
      "Return to Garage CRM to choose a plan or continue using your current plan.",
      "",
      "You can close this browser tab.",
    ].join("\n");
  }

  return [
    "Billing updated",
    "",
    "Return to Garage CRM. Billing will refresh automatically.",
    "",
    "You can close this browser tab.",
  ].join("\n");
}

Deno.serve((req) => {
  if (req.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: textHeaders(),
    });
  }

  const url = new URL(req.url);
  return new Response(message(url.searchParams.get("status") || ""), {
    status: 200,
    headers: textHeaders(),
  });
});
