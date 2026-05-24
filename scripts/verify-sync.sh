#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "========================================="
echo "  AutoCoder — Git Sync Verification"
echo "========================================="
echo ""

ERRORS=0

echo "1. Checking git status..."
if ! git diff --quiet HEAD 2>/dev/null; then
  echo -e "   ${YELLOW}⚠ Uncommitted changes detected${NC}"
  git diff --stat HEAD
  ERRORS=$((ERRORS + 1))
else
  echo -e "   ${GREEN}✓ Working tree clean${NC}"
fi

echo ""
echo "2. Fetching latest from origin..."
git fetch origin 2>/dev/null

AHEAD=$(git log --oneline origin/main..HEAD 2>/dev/null | wc -l | tr -d ' ')
BEHIND=$(git log --oneline HEAD..origin/main 2>/dev/null | wc -l | tr -d ' ')

if [ "$AHEAD" -gt 0 ] || [ "$BEHIND" -gt 0 ]; then
  echo -e "   ${RED}✗ Local and origin have diverged: ${AHEAD} ahead, ${BEHIND} behind${NC}"
  if [ "$AHEAD" -gt 0 ] && [ "$BEHIND" -gt 0 ]; then
    echo -e "   ${YELLOW}  FIX: Run 'git reset --hard origin/main' if local content matches GitHub${NC}"
    echo -e "   ${YELLOW}  Or:  Run 'git push --force origin main' if local is the source of truth${NC}"
  elif [ "$AHEAD" -gt 0 ]; then
    echo -e "   ${YELLOW}  FIX: Run 'git push origin main' to push local changes${NC}"
  else
    echo -e "   ${YELLOW}  FIX: Run 'git pull origin main' to pull remote changes${NC}"
  fi
  ERRORS=$((ERRORS + 1))
else
  echo -e "   ${GREEN}✓ Local and origin are in sync${NC}"
fi

echo ""
echo "3. Counting tracked files..."
LOCAL_COUNT=$(git ls-files | wc -l | tr -d ' ')
echo -e "   ${GREEN}✓ ${LOCAL_COUNT} tracked files${NC}"

echo ""
echo "4. Checking essential files..."
ESSENTIAL_FILES=(
  "package.json"
  "pnpm-workspace.yaml"
  "pnpm-lock.yaml"
  "tsconfig.json"
  ".gitignore"
  ".env.example"
  "README.md"
  "artifacts/api-server/package.json"
  "artifacts/api-server/tsconfig.json"
  "artifacts/api-server/src/src/index.ts"
  "artifacts/api-server/src/src/routes/autocoder.ts"
  "artifacts/api-server/src/src/modules/pipeline-orchestrator.ts"
  "artifacts/api-server/src/src/modules/knowledge-base.ts"
  "artifacts/api-server/src/src/modules/stack-knowledge-base.ts"
  "artifacts/api-server/src/src/modules/domain-knowledge.ts"
  "artifacts/api-server/src/src/modules/conversation-phase-handler.ts"
  "artifacts/api-server/src/src/modules/stacks/adapters/frontend-filter.ts"
  "artifacts/autocoder/package.json"
  "artifacts/autocoder/tsconfig.json"
  "artifacts/autocoder/vite.config.ts"
  "artifacts/autocoder/index.html"
  "artifacts/autocoder/src/pages/chat.tsx"
  "artifacts/autocoder/src/App.tsx"
)

MISSING=0
for f in "${ESSENTIAL_FILES[@]}"; do
  if ! git ls-files --error-unmatch "$f" &>/dev/null; then
    echo -e "   ${RED}✗ MISSING: $f${NC}"
    MISSING=$((MISSING + 1))
  fi
done

if [ "$MISSING" -eq 0 ]; then
  echo -e "   ${GREEN}✓ All ${#ESSENTIAL_FILES[@]} essential files present${NC}"
else
  echo -e "   ${RED}✗ ${MISSING} essential files missing${NC}"
  ERRORS=$((ERRORS + 1))
fi

echo ""
echo "5. Checking nothing leaked into tracking..."
LEAKED=0
LEAK_PATTERNS=("artifacts/api-server/cache/" "attached_assets/" "learning-data.json" "node_modules/" ".env" "dist/")
for pattern in "${LEAK_PATTERNS[@]}"; do
  COUNT=$(git ls-files | grep -c "^${pattern}" 2>/dev/null || true)
  if [ "$COUNT" -gt 0 ] && [ "$pattern" != ".env" ]; then
    echo -e "   ${RED}✗ LEAKED: ${COUNT} files matching '${pattern}'${NC}"
    LEAKED=$((LEAKED + COUNT))
  elif [ "$pattern" = ".env" ]; then
    ENV_FILES=$(git ls-files | grep "^\.env$" 2>/dev/null || true)
    if [ -n "$ENV_FILES" ]; then
      echo -e "   ${RED}✗ LEAKED: .env file is tracked (contains secrets!)${NC}"
      LEAKED=$((LEAKED + 1))
    fi
  fi
done

if [ "$LEAKED" -eq 0 ]; then
  echo -e "   ${GREEN}✓ No leaked files in tracking${NC}"
else
  ERRORS=$((ERRORS + 1))
fi

echo ""
echo "6. Quick LOC check..."
TOTAL_LINES=$(find artifacts/api-server/src artifacts/autocoder/src lib -name '*.ts' -o -name '*.tsx' -o -name '*.css' 2>/dev/null | grep -v node_modules | grep -v dist | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}')
echo -e "   ${GREEN}✓ ${TOTAL_LINES} total source lines${NC}"

echo ""
echo "========================================="
if [ "$ERRORS" -eq 0 ]; then
  echo -e "  ${GREEN}ALL CHECKS PASSED ✓${NC}"
  echo -e "  This repo is ready for clone/pull."
else
  echo -e "  ${RED}${ERRORS} CHECK(S) FAILED ✗${NC}"
  echo -e "  Fix the issues above before pushing."
fi
echo "========================================="

exit $ERRORS
