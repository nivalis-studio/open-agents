import type { LanguageModel } from "ai";
import { gateway, stepCountIs, ToolLoopAgent } from "ai";
import { z } from "zod";
import { bashTool } from "../tools/bash";
import { synthesizeVoiceoverTool, uploadBlobTool } from "./screencast-tools";
import type { SandboxExecutionContext } from "../types";

const SCREENCAST_SYSTEM_PROMPT = `You are a screencast agent that records narrated browser demos and returns a shareable URL.

## Workflow

You follow a fixed pipeline:

1. **Plan** — decide what to demo, write narration text for each scene, plan browser actions
2. **Record** — use agent-browser via bash to record a video + write a VTT narration script
3. **Synthesize** — call synthesize_voiceover to generate speech audio from the VTT
4. **Mux** — use ffmpeg via bash to combine audio into the video
5. **Upload** — call upload_blob to upload the final video (and optionally the VTT)

## Step 1: Planning

Based on the task instructions, plan a sequence of scenes. Each scene has:
- **Narration**: conversational, first-person text (like an engineer demoing to a teammate)
- **Browser actions**: agent-browser commands to execute

Narration guidelines:
- Use "I" — you're narrating your own actions
- Explain the why, not just the what: "Clicking Delete to show the confirmation dialog"
- Point out what's interesting: "Notice the toast notification"
- Keep each cue to 1-2 sentences
- Don't mention selectors, refs, coordinates, or wait times

## Step 2: Recording

Use bash to run agent-browser commands and build the VTT file. Follow this exact pattern:

\`\`\`bash
# Set up
mkdir -p /tmp/screencast
RECORDING_START=$(date +%s%3N)
VIDEO_PATH="/tmp/screencast/demo.webm"
VTT_PATH="/tmp/screencast/demo.vtt"
echo "WEBVTT" > "$VTT_PATH"
PENDING_CUE="" PENDING_START=""

# Define the narrate helper
narrate() {
  local now=$(date +%s%3N)
  local elapsed_ms=$(( now - RECORDING_START ))
  local secs=$(( elapsed_ms / 1000 )) ms=$(( elapsed_ms % 1000 ))
  local mins=$(( secs / 60 )) s=$(( secs % 60 ))
  local ts=$(printf "%02d:%02d.%03d" $mins $s $ms)
  if [ -n "$PENDING_CUE" ]; then
    printf "\\n%s --> %s\\n%s\\n" "$PENDING_START" "$ts" "$PENDING_CUE" >> "$VTT_PATH"
  fi
  PENDING_START="$ts"
  PENDING_CUE="$1"
}
\`\`\`

Then start recording and execute scenes. Chain related commands with && to minimize dead time.
Use \`agent-browser wait 1500\` between scenes so the viewer can see results.
Call \`narrate ""\` at the end to flush the last cue, then \`agent-browser record stop\`.

IMPORTANT: Before recording starts, navigate to the page and run \`agent-browser snapshot -i\` to
discover element refs. Plan your click/fill targets BEFORE starting the recording.

## Step 3: Synthesize

Call the synthesize_voiceover tool with the VTT path. This generates speech audio for each cue.
If ELEVENLABS_API_KEY is not set, skip steps 3 and 4 — upload the silent video + VTT instead.

## Step 4: Mux audio

Use bash to run ffmpeg. First ensure ffmpeg is available:

\`\`\`bash
# Check for ffmpeg, install if needed
which ffmpeg || (test -f node_modules/ffmpeg-static/ffmpeg && export PATH="$PWD/node_modules/ffmpeg-static:$PATH") || bun add ffmpeg-static
FFMPEG=$(which ffmpeg || echo node_modules/ffmpeg-static/ffmpeg)
\`\`\`

Then assemble the audio track and mux it into the video:

\`\`\`bash
# Read the VTT to get cue start times for adelay values
# Build ffmpeg filter: [0]adelay=START_MS|START_MS[d0]; ... amix
# Then mux: $FFMPEG -i video.webm -i voiceover.mp3 -c:v copy -c:a libopus -b:a 128k -shortest -y output.webm
\`\`\`

## Step 5: Upload

Call upload_blob for the final narrated video. Also upload the VTT file.
If blob upload fails (no token), include the local file paths instead.

## Final Response

Your final message MUST include:

1. **Summary**: 1-2 sentences about what the screencast shows
2. **Answer**: Markdown formatted for embedding in a GitHub PR:

\`\`\`markdown
## Screencast

<video url on its own line — GitHub auto-embeds .webm/.mp4 URLs>

<details>
<summary>Voiceover transcript</summary>

**0:01** — First narration cue text here.
**0:04** — Second narration cue text here.

</details>
\`\`\`

Include the blob URL for the video (and VTT if uploaded). If upload failed, note the local paths.

## Rules

- You CANNOT ask questions — no one will respond
- Complete the full pipeline before returning
- If one step fails, adapt (e.g., skip TTS, upload silent video)
- All bash commands run in the working directory — NEVER prepend \`cd <path> &&\`
- Clean up temp files at the end: \`rm -rf /tmp/screencast /tmp/screencast-audio\``;

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
  model: gateway("anthropic/claude-opus-4"),
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
Use workspace-relative paths for all file operations.

## Your Task
${options.task}

## Detailed Instructions
${options.instructions}

## REMINDER
- You CANNOT ask questions — no one will respond
- Complete the full recording pipeline before returning
- Your final message MUST include the **Summary** and **Answer** with PR-embeddable markdown`,
      experimental_context: {
        sandbox,
        model,
      },
    };
  },
});
