# Reproduction evidence

An external AI can use the existing Engram connection to operate its browser and collect evidence. Engram performs the requested operations; it does not start another autonomous coding agent.

1. Start an approved task with `engram_begin`, then open the known application URL.
2. Establish the current build, account role, test data and a positive ready state with `verify` or `wait_for`.
3. Call `record_start` **before** reproducing the issue, perform the actions, then `record_stop`. `capture_evidence` saves a still image instead.
4. Make the code change in the coding client. Open the changed build, repeat the same checks and collect new after-evidence. A video alone is not proof that a fix works.
5. Review the generated files. `upload_file` requires the artifact id, exact destination URL, file-input label and expected completion text. Approval happens before file selection, which may immediately transmit the file. Confirm the saved attachment, not merely its preview. Do not retry uncertain uploads blindly.
6. Use `engram_finish` to report verified results and any remaining uncertainty. Save a routine with `engram_keep` only after the person confirms success. Merge or publish only with separate authority.

Example check arguments:

```json
{"id":"results-ready","url":"https://example.test/results","ready":"Results loaded","present":["Saved"],"absent":["Unexpected error"]}
```

Checks inspect fresh extracted page text. They do not prove visual layout, hidden state, server persistence or full task correctness. A wrong URL, login wall, missing ready state or truncated absence check cannot pass.

Recordings capture **one Engram browser tab**, without audio, for at most 120 seconds. They do not record arbitrary desktop applications or follow newly opened tabs. The app shows recording status and a stop button. Task cancellation, tab closure and leaving the approved site interrupt capture. Stop explicitly to obtain the artifact and provenance receipt before finishing.

For a partial screenshot or recording, supply `region: { x, y, width, height }` in visible viewport CSS pixels from a fresh observation. The approval shows the rectangle. Secret masking happens before cropping. This is a fixed viewport area, not an element tracker or an operating-system drag-to-select picker; scrolling changes what appears in it, and a resize that puts it outside the viewport stops capture. WebM is the video format, not a renamed screenshot.

Password, payment-autocomplete and one-time-code inputs are masked. Supply additional CSS selectors through `masks` for other private content; a missing requested target stops capture rather than silently removing the mask. This is not automatic detection of all personal information: inspect every artifact before sharing. Evidence remains in the local artifact directory until explicitly uploaded. Closing the app is not a substitute for stopping and saving a recording.

PNG/WebM outputs include a separate JSON provenance file with the supplied issue/build/role/test-data context, source URL, capture time and content hash. Those labels are caller-supplied context, not independently verified assertions. Uploads are limited to supported Engram artifacts and reject modified files. This version supports labeled file inputs; sites requiring native file-picker dialogs without a labeled input may need a manual attachment step.
