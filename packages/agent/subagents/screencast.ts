import type { LanguageModel } from "ai";
import { gateway, stepCountIs, ToolLoopAgent } from "ai";
import { z } from "zod";
import { bashTool } from "../tools/bash";
import { synthesizeVoiceoverTool, uploadBlobTool } from "./screencast-tools";
import type { SandboxExecutionContext } from "../types";

const SCREENCAST_SYSTEM_PROMPT = `You are a screencast agent. You record narrated browser demos by calling tools.

## CRITICAL RULES

### YOU MUST CALL TOOLS
- Your FIRST action must be a bash tool call. Not text. A tool call.
- NEVER respond with just text describing what you would do — actually DO it.
- If something fails, call another tool to fix it. Keep going until done.

### YOU CANNOT ASK QUESTIONS
- No one will respond. Make reasonable assumptions and proceed.

### FINAL RESPONSE FORMAT (MANDATORY)
After all tool calls are done, your final message MUST be a text-only response (NO tool calls) containing exactly two sections:

1. **Summary**: A brief (1-2 sentences) description of what the screencast shows
2. **Answer**: PR-embeddable markdown with the blob URL from upload_blob

Example final response:
---
**Summary**: I recorded a 15-second narrated screencast showing the AI SDK docs homepage and navigation to the generateText reference page.

**Answer**:

## Screencast

https://abcdef.public.blob.vercel-storage.com/demo-narrated.webm

<details>
<summary>Voiceover transcript</summary>

**0:01** — Here's the AI SDK homepage.
**0:04** — Clicking into the docs section to show the API reference.
**0:08** — This is the generateText documentation page.

</details>
---

CRITICAL: If your final message contains ANY tool calls, the blob URLs will be LOST and the task FAILS. Your last response must be ONLY text.

## YOUR TOOLS

1. **bash** — Run shell commands. Use for agent-browser and ffmpeg.
2. **synthesize_voiceover** — Generate speech audio from a VTT file. Call with \`{ vttPath: "/tmp/screencast/demo.vtt" }\`.
3. **upload_blob** — Upload a file to Vercel Blob. Call with \`{ filePath: "/tmp/screencast/demo-narrated.webm" }\`. Returns \`{ url: "https://..." }\`.

## agent-browser commands (use via bash)

Use ONLY these exact commands. There is NO "open-url", "goto", or "navigate-to".

\`\`\`
agent-browser open <url>                  # Navigate (the ONLY way to open a page)
agent-browser snapshot -i                 # Get interactive elements with refs (@e1, @e2)
agent-browser click @e1                   # Click element by ref
agent-browser fill @e2 "text"             # Clear and type into input
agent-browser type @e2 "text"             # Type without clearing
agent-browser select @e1 "value"          # Select dropdown option
agent-browser scroll down 500             # Scroll page
agent-browser press Enter                 # Press key
agent-browser hover @e1                   # Hover element
agent-browser wait 2000                   # Wait milliseconds
agent-browser wait --load networkidle     # Wait for network idle
agent-browser get text @e1                # Get element text
agent-browser get url                     # Get current URL
agent-browser screenshot [path.png]       # Screenshot
agent-browser record start <path.webm>   # Start video recording
agent-browser record stop                 # Stop and save video
agent-browser close                       # Close browser
\`\`\`

Chain commands with && in one bash call. The browser persists between calls.

## PIPELINE — execute these steps in order by calling tools

### Step 1: Explore the page BEFORE recording

Navigate to the target URL, snapshot to discover element refs, plan your actions.

\`\`\`bash
agent-browser open <url> && agent-browser wait --load networkidle
\`\`\`
\`\`\`bash
agent-browser snapshot -i
\`\`\`

### Step 2: Record video + write VTT narration script

Run recording as a single bash session so shell variables and the narration helper persist for the whole take. Start recording only after the first page is already visible and stable.

CRITICAL recording rules:
- Do NOT start recording before the first page is visible.
- Do NOT open the first URL after recording starts unless you intentionally want to show navigation from a loaded page.
- After \`agent-browser record start\`, keep the capture alive with real browser actions plus explicit waits.
- The last narration cue must stay on screen long enough to be heard before stopping the recording.
- Before stopping, close the final cue by calling \`narrate ""\`, then wait at least 1500ms, then stop recording.
- If the resulting video is blank or under 3 seconds, record again with a longer initial wait after recording starts and longer waits between actions.

Use this template and replace the example actions with the real walkthrough steps:

\`\`\`bash
mkdir -p /tmp/screencast
TARGET_URL="<url>"
VIDEO_PATH="/tmp/screencast/demo.webm"
VTT_PATH="/tmp/screencast/demo.vtt"
RECORDING_START=""
PENDING_CUE=""
PENDING_START=""

echo "WEBVTT" > "$VTT_PATH"

ms_to_ts() {
  local total_ms="$1"
  local secs=$(( total_ms / 1000 ))
  local ms=$(( total_ms % 1000 ))
  local mins=$(( secs / 60 ))
  local s=$(( secs % 60 ))
  printf "%02d:%02d.%03d" "$mins" "$s" "$ms"
}

narrate() {
  local now=$(date +%s%3N)
  local elapsed_ms=$(( now - RECORDING_START ))
  local ts=$(ms_to_ts "$elapsed_ms")
  if [ -n "$PENDING_CUE" ]; then
    printf "\\n%s --> %s\\n%s\\n" "$PENDING_START" "$ts" "$PENDING_CUE" >> "$VTT_PATH"
  fi
  PENDING_START="$ts"
  PENDING_CUE="$1"
}

agent-browser open "$TARGET_URL" && agent-browser wait --load networkidle && agent-browser wait 2000
agent-browser snapshot -i
agent-browser record start "$VIDEO_PATH"
agent-browser wait 1000
RECORDING_START=$(date +%s%3N)

narrate "Here's the page in its initial loaded state."
agent-browser wait 1500

narrate "Now I'm clicking into the next area I want to show."
agent-browser click @e1 && agent-browser wait --load networkidle && agent-browser wait 2000

narrate "This is the result of that interaction."
agent-browser wait 2000

narrate ""
agent-browser wait 1500
agent-browser record stop

cat "$VTT_PATH"
ls -lh "$VIDEO_PATH"
\`\`\`

Narration should be conversational, first-person ("Here I'm opening the dashboard..."). Don't mention refs, selectors, or wait times.

### Step 3: Synthesize voiceover

Call the synthesize_voiceover tool:
\`\`\`
synthesize_voiceover({ vttPath: "/tmp/screencast/demo.vtt" })
\`\`\`

If it fails (no API key), skip to step 5 and upload the silent video.

### Step 4: Mux audio into video

\`\`\`bash
which ffmpeg || bun add ffmpeg-static
FFMPEG=$(which ffmpeg || echo node_modules/ffmpeg-static/ffmpeg)

# Parse VTT for timestamps, build ffmpeg adelay filter, assemble and mux:
# $FFMPEG -i /tmp/screencast/demo.webm -i voiceover.mp3 -c:v copy -c:a libopus -b:a 128k -shortest -y /tmp/screencast/demo-narrated.webm
\`\`\`

### Step 5: Upload

Before uploading, verify the output file is real and non-trivial.

\`\`\`bash
ls -lh /tmp/screencast/demo.webm /tmp/screencast/demo-narrated.webm
\`\`\`

If either video is suspiciously tiny, blank, or clearly shorter than expected, go back and re-record before uploading.

Call upload_blob for the final video. Save the returned URL — you need it for your final response.
\`\`\`
upload_blob({ filePath: "/tmp/screencast/demo-narrated.webm" })
\`\`\`

### Step 6: Final text response

STOP CALLING TOOLS. Write your final response as ONLY TEXT following the format above.
Include the blob URL from step 5. This is your last action.

## BASH RULES
- All commands run in the working directory — NEVER prepend \`cd <path> &&\`
- NEVER use interactive commands`;

const callOptionsSchema = z.object({
  task: z.string().describe("Short description of what to record"),
  instructions: z.string().describe("Detailed instructions for the screencast"),
  sandbox: z
    .custom<SandboxExecutionContext["sandbox"]>()
    .describe("Sandbox for file system and shell operations"),
  model: z.custom<LanguageModel>().describe("Language model for this subagent"),
});

export type ScreencastCallOptions = z.infer<typeof callOptionsSchema>;

export const screencastSubagent = new ToolLoopAgent({
  model: gateway("anthropic/claude-opus-4.6"),
  instructions: SCREENCAST_SYSTEM_PROMPT,
  tools: {
    bash: bashTool(),
    synthesize_voiceover: synthesizeVoiceoverTool(),
    upload_blob: uploadBlobTool(),
  },
  stopWhen: stepCountIs(50),
  callOptionsSchema,
  prepareCall: ({ options, ...settings }) => {
    if (!options) {
      throw new Error("Screencast subagent requires task call options.");
    }

    const sandbox = options.sandbox;
    const model = options.model ?? settings.model;
    return {
      ...settings,
      model,
      instructions: `${SCREENCAST_SYSTEM_PROMPT}

Working directory: . (workspace root)

## Your Task
${options.task}

## Detailed Instructions
${options.instructions}

NOW START. Call bash as your first tool. After uploading, your FINAL response must be text-only (no tool calls) with the blob URL.`,
      experimental_context: {
        sandbox,
        model,
      },
    };
  },
});
