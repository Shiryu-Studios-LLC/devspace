#!/usr/bin/env bash
set -u
PROJECT="${1:-}"
GENERATOR="/home/okashi/Unreal/Engine/Build/BatchFiles/Linux/GenerateProjectFiles.sh"

if [[ -z "$PROJECT" ]]; then
  echo "No .uproject path was provided."
  exit 2
fi

if [[ ! -f "$PROJECT" ]]; then
  echo "Project file not found:"
  echo "$PROJECT"
  exit 3
fi

printf 'Generating Rider project files for:\n%s\n\n' "$PROJECT"
"$GENERATOR" -Rider -project="$PROJECT"
STATUS=$?

printf '\n'
if [[ $STATUS -eq 0 ]]; then
  echo "Rider project generation completed successfully."
  exit 0
else
  echo "Rider project generation failed with exit code $STATUS."
  printf '\nPress Enter to close...'
  read -r _
  exit $STATUS
fi
