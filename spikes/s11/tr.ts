// Spike S11: prints the lines of a transcript that matter here (messages, hook attachments and the
// user/system messages as they were sent to the API). Usage: bun tr.ts <transcript.jsonl> [from-line]
const lines = (await Bun.file(process.argv[2] as string).text()).trim().split("\n");
const from = Number(process.argv[3] ?? 0);
lines.forEach((l, i) => {
  if (i < from) return;
  const j = JSON.parse(l);
  let body: unknown;
  if (j.type === "user" || j.type === "assistant") {
    body = j.message?.content;
    if (Array.isArray(body))
      body = body.map((b) => (b.type === "thinking" ? { type: "thinking" } : b));
  } else if (j.type === "attachment" && /hook/.test(j.attachment?.type ?? "")) body = j.attachment;
  else if (
    j.type === "api-request-blob" &&
    j.message?.role !== "assistant" &&
    !/^(<system-reminder>|# Environment)/.test(j.message?.content?.[0]?.text ?? "")
  )
    body = j.message;
  else if (
    j.type === "system" &&
    /hook/.test(j.subtype ?? "") &&
    (j.hookErrors?.length || j.hasOutput)
  )
    body = j;
  else return;
  console.log(`${i} ${j.type} ${JSON.stringify(body).slice(0, 1200)}`);
});
console.log(`lines: ${lines.length}`);
