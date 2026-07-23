---
name: github-push
description: Automates the process of staging changes, generating an AI commit message based on git diff, asking for user approval, and pushing to GitHub. Triggered by phrases like "push to github", "commit my changes", or "auto commit".
---

# GitHub Push & Auto-Commit Workflow

When the user asks to push changes to GitHub or run the auto-commit workflow, follow these exact steps sequentially:

1.  **Check Status & Stage**:
    *   Run `git status` to see the current state.
    *   If there are unstaged changes, automatically stage everything using `git add .` (unless the user specifically requested only certain files).

2.  **Analyze Changes**:
    *   Run `git diff --cached` to get the diff of the staged changes. (If the diff is extremely large, use `git diff --cached --stat` to get an overview first).

3.  **Generate Commit Message**:
    *   Based on the diff, generate a meaningful and professional commit message.
    *   **Title**: A short, descriptive title (50 characters or less). Use the Conventional Commits format if applicable (e.g., `feat:`, `fix:`, `docs:`, `refactor:`).
    *   **Description**: An extended description explaining *what* was changed and *why*, matching the level of detail Copilot provides.

4.  **Request Approval**:
    *   Present the proposed commit title and description to the user.
    *   **STOP** and explicitly ask for the user's approval to proceed.

5.  **Commit and Push**:
    *   Once the user approves, execute the commit using `git commit -m "<Title>" -m "<Description>"`.
    *   Run `git push` to push the changes to the remote repository.
    *   Confirm with the user that the push was successful.
