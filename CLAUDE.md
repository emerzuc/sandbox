# CLAUDE.md - AI Assistant Guide for Sandbox Repository

**Last Updated:** 2025-11-26
**Repository:** emerzuc/sandbox
**Branch Pattern:** `claude/*`

---

## Table of Contents

1. [Repository Overview](#repository-overview)
2. [Current State](#current-state)
3. [Development Workflow](#development-workflow)
4. [Git Conventions](#git-conventions)
5. [Code Structure Guidelines](#code-structure-guidelines)
6. [AI Assistant Guidelines](#ai-assistant-guidelines)
7. [Future Development Considerations](#future-development-considerations)

---

## Repository Overview

### Purpose
This is a **sandbox repository** designed for experimentation, prototyping, and testing. It currently contains minimal structure and serves as a blank canvas for future development.

### Repository Metadata
- **Owner:** emerzuc
- **Repository Name:** sandbox
- **Initial Commit:** f73c891 (Nov 20, 2019)
- **Current Branch:** `claude/claude-md-mignjmoddkn0j912-01189bHUvz6styHc3h4s52zh`
- **Git Status:** Clean working directory

---

## Current State

### Project Structure

```
/home/user/sandbox/
├── .git/              # Git version control
├── README.md          # Minimal project documentation
└── CLAUDE.md          # This file - AI assistant guide
```

### Existing Files
- **README.md**: Single-line markdown file containing "# sandbox"
- **CLAUDE.md**: Comprehensive guide for AI assistants (this document)

### What's Missing (To Be Added)
- [ ] Source code files
- [ ] Configuration files (e.g., `.gitignore`, language-specific configs)
- [ ] Dependency management (e.g., `package.json`, `requirements.txt`, `Gemfile`)
- [ ] Testing framework and test files
- [ ] Build/deployment scripts
- [ ] CI/CD configuration
- [ ] License file
- [ ] Contributing guidelines
- [ ] Code of conduct
- [ ] Issue and PR templates

---

## Development Workflow

### Branch Strategy

**Feature Branches:**
- All AI-assisted development happens on branches prefixed with `claude/`
- Branch naming pattern: `claude/claude-md-<session-id>`
- Example: `claude/claude-md-mignjmoddkn0j912-01189bHUvz6styHc3h4s52zh`

**Main/Master Branch:**
- Currently no designated main branch
- Future consideration: Establish `main` or `master` as the primary branch
- Protected branch policies to be defined when project matures

### Development Process

1. **Create Feature Branch**
   ```bash
   git checkout -b claude/feature-description-<session-id>
   ```

2. **Develop and Test**
   - Make incremental commits with clear messages
   - Test changes locally before committing
   - Follow code conventions (to be established)

3. **Commit Changes**
   ```bash
   git add <files>
   git commit -m "Clear, descriptive commit message"
   ```

4. **Push to Remote**
   ```bash
   git push -u origin <branch-name>
   ```

5. **Create Pull Request**
   - Use `gh pr create` when ready for review
   - Provide comprehensive PR description
   - Include testing checklist

---

## Git Conventions

### Commit Message Format

Follow the **Conventional Commits** specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks, dependency updates
- `perf`: Performance improvements
- `ci`: CI/CD configuration changes

**Examples:**
```
feat: add user authentication module
fix: resolve null pointer exception in data parser
docs: update README with installation instructions
refactor: simplify configuration loading logic
```

### Branch Naming Conventions

**AI-Assisted Development:**
- `claude/<description>-<session-id>`
- Must start with `claude/` prefix for push authorization
- Must include session ID suffix for security

**Future Conventions (when team expands):**
- `feature/<description>`: New features
- `bugfix/<description>`: Bug fixes
- `hotfix/<description>`: Urgent production fixes
- `docs/<description>`: Documentation updates
- `refactor/<description>`: Code refactoring

### Git Push Requirements

**Critical Rules:**
1. Always use: `git push -u origin <branch-name>`
2. Branch MUST start with `claude/` and end with matching session ID
3. Push failures due to branch naming will return HTTP 403
4. Network errors: Retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s)

**Retry Logic Example:**
```bash
# Attempt 1
git push -u origin <branch> || sleep 2

# Attempt 2
git push -u origin <branch> || sleep 4

# Attempt 3
git push -u origin <branch> || sleep 8

# Attempt 4 (final)
git push -u origin <branch>
```

### Git Safety Protocol

**NEVER:**
- Update git config without explicit permission
- Run destructive/irreversible commands (`push --force`, `reset --hard`) without approval
- Skip hooks (`--no-verify`, `--no-gpg-sign`) without permission
- Force push to main/master branches
- Amend commits authored by others

**ALWAYS:**
- Check authorship before amending: `git log -1 --format='%an %ae'`
- Verify commits are not pushed before amending
- Create new commits instead of amending when in doubt
- Fetch specific branches: `git fetch origin <branch-name>`

---

## Code Structure Guidelines

### General Principles

**When Project Code is Added:**

1. **Modularity**: Organize code into logical, reusable modules
2. **Separation of Concerns**: Keep business logic, UI, and data access separate
3. **DRY (Don't Repeat Yourself)**: Avoid code duplication
4. **KISS (Keep It Simple, Stupid)**: Prefer simple solutions over complex ones
5. **YAGNI (You Aren't Gonna Need It)**: Don't add functionality until needed

### Recommended Directory Structure

**For Web Applications:**
```
/
├── src/                  # Source code
│   ├── components/       # Reusable components
│   ├── services/         # Business logic and API calls
│   ├── utils/           # Utility functions
│   ├── config/          # Configuration files
│   └── types/           # Type definitions (TypeScript)
├── tests/               # Test files
├── docs/                # Documentation
├── scripts/             # Build and utility scripts
├── public/              # Static assets
└── config/              # Project configuration
```

**For Python Projects:**
```
/
├── src/                 # Source code
│   └── <package_name>/  # Main package
├── tests/               # Test files
├── docs/                # Documentation
├── scripts/             # Utility scripts
├── requirements.txt     # Dependencies
├── setup.py            # Package setup
└── README.md           # Documentation
```

### File Naming Conventions

**To Be Established Based on Language:**

- **JavaScript/TypeScript**: camelCase for files, PascalCase for classes
- **Python**: snake_case for modules and files
- **CSS/SCSS**: kebab-case for stylesheets
- **Configuration**: lowercase with dots/dashes (e.g., `.eslintrc.js`, `tsconfig.json`)

### Code Style

**When Code is Added:**

1. **Consistency**: Follow existing patterns in the codebase
2. **Readability**: Write self-documenting code with clear variable names
3. **Comments**: Use sparingly; explain "why" not "what"
4. **Error Handling**: Handle errors gracefully at system boundaries
5. **Security**: Validate input at boundaries, sanitize output, avoid common vulnerabilities

**Avoid:**
- Over-engineering and premature optimization
- Adding features beyond requirements
- Excessive error handling for internal code
- Backwards-compatibility hacks in new code
- Creating abstractions for one-time operations

---

## AI Assistant Guidelines

### Core Principles for AI Development

#### 1. Read Before Modifying
- **NEVER** propose changes to unread code
- **ALWAYS** read files before suggesting modifications
- Understand existing patterns and conventions

#### 2. Task Management
- Use `TodoWrite` tool for multi-step tasks
- Mark tasks `in_progress` before starting
- Mark tasks `completed` immediately upon finish
- Maximum ONE task in_progress at a time

#### 3. Minimal, Focused Changes
- Make only requested changes
- Don't add unrequested features or refactoring
- Don't add comments/docs to unchanged code
- Keep solutions simple and direct

#### 4. Security Awareness
- Check for common vulnerabilities (OWASP Top 10)
- Validate input at system boundaries
- Sanitize output to prevent injection attacks
- Never commit secrets or credentials

#### 5. Tool Usage Preferences

**File Operations:**
- Use `Read` tool (not `cat`, `head`, `tail`)
- Use `Edit` tool (not `sed`, `awk`)
- Use `Write` tool (not `echo >` or heredocs)
- Use `Glob` tool (not `find`, `ls`)
- Use `Grep` tool (not `grep`, `rg`)

**Exploration:**
- Use `Task` tool with `subagent_type=Explore` for codebase exploration
- Don't run multiple search commands for understanding architecture
- Specify thoroughness: "quick", "medium", or "very thorough"

**Parallel Execution:**
- Execute independent operations in parallel
- Use single message with multiple tool calls
- Chain dependent operations sequentially with `&&`

### Workflow for Code Changes

**Step-by-Step Process:**

1. **Understand Requirements**
   - Read user request carefully
   - Ask clarifying questions if ambiguous
   - Confirm approach if multiple solutions exist

2. **Explore Codebase** (if needed)
   - Use `Task` tool with `Explore` agent
   - Read relevant files
   - Understand existing patterns

3. **Plan Work** (for complex tasks)
   - Use `TodoWrite` to create task list
   - Break down into actionable steps
   - Provide both imperative and active forms

4. **Implement Changes**
   - Read files before editing
   - Make minimal, focused changes
   - Test changes if possible
   - Update todo list progress

5. **Commit and Push**
   - Stage relevant files
   - Write clear commit message
   - Push to designated branch
   - Create PR if requested

### Communication Style

- **Concise**: Keep responses short and to the point
- **No Emojis**: Unless explicitly requested by user
- **Technical**: Focus on facts, not validation
- **Markdown**: Use GitHub-flavored markdown for formatting
- **Code References**: Use `file_path:line_number` format

### Error Handling

**When Errors Occur:**

1. Read error messages carefully
2. Check file paths and permissions
3. Verify branch naming conventions
4. Review git status and remote configuration
5. Retry network operations with backoff
6. Ask user for clarification if blocked

**Hook Failures:**

- Treat hook feedback as user input
- Adjust actions in response to blocked messages
- Ask user to check hook configuration if stuck

---

## Future Development Considerations

### Technology Stack

**To Be Determined:**
- Programming language(s)
- Framework(s)
- Database system
- Testing framework
- Build tools
- CI/CD platform

### Configuration Files to Add

When project development begins:

1. **Version Control**
   - `.gitignore`: Exclude build artifacts, dependencies, secrets
   - `.gitattributes`: Line ending and diff configurations

2. **Language/Framework Specific**
   - `package.json` (Node.js)
   - `requirements.txt` or `pyproject.toml` (Python)
   - `Gemfile` (Ruby)
   - `Cargo.toml` (Rust)
   - `go.mod` (Go)

3. **Code Quality**
   - Linter configuration (`.eslintrc`, `.pylintrc`, etc.)
   - Formatter configuration (`.prettierrc`, `.editorconfig`)
   - Type checking configuration (`tsconfig.json`, `mypy.ini`)

4. **Testing**
   - Test framework configuration
   - Coverage reports configuration
   - Test data fixtures

5. **CI/CD**
   - `.github/workflows/` for GitHub Actions
   - `.travis.yml`, `.circleci/config.yml`, etc.

6. **Documentation**
   - `CONTRIBUTING.md`: Contribution guidelines
   - `LICENSE`: License information
   - `CODE_OF_CONDUCT.md`: Community guidelines
   - `.github/ISSUE_TEMPLATE/`: Issue templates
   - `.github/PULL_REQUEST_TEMPLATE.md`: PR template

7. **Containerization**
   - `Dockerfile`: Container definition
   - `docker-compose.yml`: Multi-container orchestration
   - `.dockerignore`: Exclude files from image

### Testing Strategy

**When Tests are Added:**

1. **Unit Tests**: Test individual functions/methods
2. **Integration Tests**: Test component interactions
3. **End-to-End Tests**: Test complete workflows
4. **Coverage Target**: Aim for 80%+ code coverage
5. **Test Location**: Mirror source structure in `tests/` directory

### Documentation Standards

**Essential Documentation:**

1. **README.md**: Project overview, setup, usage
2. **API Documentation**: Endpoint/function references
3. **Architecture Docs**: System design and patterns
4. **Setup Guides**: Development environment setup
5. **Troubleshooting**: Common issues and solutions

---

## Quick Reference

### Common Commands

**Git Operations:**
```bash
# Check status
git status

# Create and switch to new branch
git checkout -b claude/feature-name-<session-id>

# Stage changes
git add <file>

# Commit with message
git commit -m "type: description"

# Push to remote
git push -u origin <branch-name>

# Create pull request
gh pr create --title "Title" --body "Description"
```

**File Operations (via AI tools):**
```
Read tool: Read file contents
Edit tool: Modify existing files
Write tool: Create new files
Glob tool: Find files by pattern
Grep tool: Search code content
```

### Decision Tree for AI Assistants

```
User Request
    │
    ├─ Simple query (1-2 steps)
    │   └─> Execute directly, no TodoWrite
    │
    ├─ Complex task (3+ steps)
    │   └─> Create TodoWrite task list
    │
    ├─ Code modification
    │   ├─> Read files first
    │   ├─> Make minimal changes
    │   └─> Test if possible
    │
    ├─ Codebase exploration
    │   └─> Use Task tool with Explore agent
    │
    └─ Git operations
        ├─> Follow branch naming conventions
        ├─> Write clear commit messages
        └─> Push with retry logic
```

---

## Changelog

### 2025-11-26
- **Created** initial CLAUDE.md file
- Documented current repository state (minimal sandbox)
- Established git conventions and workflows
- Defined AI assistant guidelines
- Added future development considerations

---

## Contact and Support

**For Questions:**
- Review this documentation first
- Check repository issues for similar questions
- Create new issue if needed

**For AI Assistants:**
- Follow guidelines in this document
- Use appropriate tools for each operation
- Ask for clarification when requirements are ambiguous
- Document any new patterns or conventions discovered

---

**Note:** This document will be updated as the repository evolves and new patterns emerge. AI assistants should always refer to the latest version when working with this repository.
