import { readSource } from "./runtime.mjs";
let input = "";
const deadline = setTimeout(() => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: "Zeitlimit beim Lesen der Datenquelle erreicht.",
    }),
  );
  process.exit(1);
}, 90000);
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 256 * 1024 * 1024)
      throw new Error("Datei ist für den Import zu groß.");
  }
  const data = await readSource(JSON.parse(input));
  process.stdout.write(JSON.stringify({ ok: true, data }));
} catch (error) {
  // Drivers sometimes include credentials in errors. Remove URI authentication.
  const message = String(error.message).replace(
    /(mongodb(?:\+srv)?|postgres(?:ql)?|mysql):\/\/[^@\s]+@/g,
    "$1://***@",
  );
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
