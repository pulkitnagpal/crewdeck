---
tags: jobs
# What you want. Change it here, on the Jobs page, or by telling Claude (it runs `crewdeck jobs pref set …`).
roles:
  # One entry per kind of job you want: your name for it, the titles postings use (any language), its field. A posting
  # passes when its title has every word of one of them, in any order; plurals, gendered forms and seniority don't block.
  # e.g. - { name: Nurse, titles: [registered nurse, RN, staff nurse], families: [healthcare] }
  targets: []
  titles: []                 # more titles, read as one more kind of job
  level: any                 # entry | experienced | senior | any
  seniority_prefer: []       # ordering, not a filter, e.g. [senior, lead]
  exclude_title_words: []    # whole words, e.g. [intern, internship, sales]
workplace: []                # remote | hybrid | onsite
places:
  onsite: []                 # cities you can work in on-site or hybrid ("Town, Country" for small towns)
  remote_from: []            # countries, regions or states you can work remotely from; worldwide = anywhere
  commute_km: 50             # how far from those cities a workplace may be
  relocate_to: []            # cities you would move to for a job (on-site there passes)
  authorized_in: []          # countries where you may work without sponsorship, e.g. [United States]
languages: []                # e.g. [{ name: German, level: C1 }]; basic | conversational | professional | fluent | native, or A1–C2
employment_types: []         # full-time | part-time | contract | freelance | per-diem | internship | apprenticeship | temporary | fixed-term | seasonal
licenses: []                 # e.g. ["Forklift", { name: RN, where: Ohio }]; the judge checks what postings require
needs_sponsorship: false
work_pattern:                # how you can work, only what you say (the judge never guesses)
  shifts: []                 # shifts you can work: day | evening | night | weekend | rotating | on-call
  shifts_avoid: []           # shifts you can't work
  hours_per_week: {}         # e.g. { min: 20, max: 32 }
  term_time_only: false      # schools: term-time contracts only
exclude:
  companies: []
  industries: []             # e.g. [gambling, crypto]
  travel: off                # the lowest travel that rules a job out: off | occasional | frequent
companies:                   # where the companies themselves are from (headquartered), as country codes (in, us, de …)
  countries: { only: [], exclude: [] }   # e.g. exclude: [in] = only non-Indian companies; unknown companies go to the judge
pay:
  currency: ""               # your currency code, e.g. EUR, USD, INR
  floor: 0                   # your minimum in that currency per period; 0 = no floor
  period: year               # year | month | week | day | hour
  rule: top_of_range         # top_of_range: keep if the top reaches the floor; bottom_of_range: the bottom must
  unlisted: keep             # keep | drop postings that show no pay
  fx: {}                     # 1 unit of another currency in yours, e.g. { USD: 0.92 }
  # hours_per_week: 36       # the hours you work: converts a month or a year into an hour or a day (else 40)
  # days_per_week: 3         # for a day rate (else 5)
  # per_unit: "€0.08 a word" # pay per word, page or project, in your words: for the judge, never a floor
schedule: { timezone: "", daily_picks: 5, cooldown_days: 60, cooldown_scope: company, per_company: 1 }   # cooldown_scope: company | role (the same title only)
judge_notes: ""              # anything else, in your words, for the judging step
---
# Job search

## Changes
