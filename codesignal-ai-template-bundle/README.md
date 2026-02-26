# CodeSignal Template Bundle: Single Scenario Generator

This bundle generates one phishing scenario and outputs only title + solution code.

## Template type
- `task`

## Inputs
- `CHANNEL_TYPE` (required): `gmail` | `slack` | `sms`
- `EXTRA_CONTEXT` (optional)

## Outputs
- `TASK_TITLE`
- `DESCRIPTION` (intentionally empty)
- `SOLUTION_FILES` (parsed from the Solution Code section)

## Flow
1. `Set Context` (understand request)
2. Conditional generation by channel:
   - `generate-gmail-scenario`
   - `generate-slack-scenario`
   - `generate-sms-scenario`
3. Generate title (`generate-task-title`)
4. Format solution section (`format-solution-code-yaml`)
5. Parse solution section into `SOLUTION_FILES`

## Prompt files
- `prompts/understand-context.txt`
- `prompts/generate-gmail-scenario.txt`
- `prompts/generate-slack-scenario.txt`
- `prompts/generate-sms-scenario.txt`
- `prompts/generate-task-title.txt`
- `prompts/format-solution-code-yaml.txt`
- `systems/phishing-scenario-generator-system.txt`
