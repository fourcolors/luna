# Issue tracker: GitHub

Issues and PRDs for Luna live in `fourcolors/luna` GitHub Issues. Use the `gh` CLI for issue operations.

## Conventions

- Create: `gh issue create --repo fourcolors/luna --title "..." --body-file <file>`
- Read: `gh issue view <number> --repo fourcolors/luna --comments`
- List: `gh issue list --repo fourcolors/luna --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --repo fourcolors/luna --body-file <file>`
- Label: `gh issue edit <number> --repo fourcolors/luna --add-label "..."`
- Close: `gh issue close <number> --repo fourcolors/luna --comment "..."`

When an engineering skill says to publish to the issue tracker, create a GitHub issue in this repository.
