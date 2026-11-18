---
tags: jobs
# Preset: onsite-city. Regional boards, all off: setup switches on the ones for your region (enabled: true).
# The watchlist is where local employers go, by their careers page. (Some regional boards, e.g. Canada's Job Bank,
# Sweden's Platsbanken and Flanders' VDAB, need an npm package and can't run in Crewdeck's sandbox.)
boards:
  - { name: Arbeitnow, provider: arbeitnow, enabled: false }                # Germany
  - { name: Bundesagentur für Arbeit, provider: arbeitsagentur, enabled: false }   # Germany
  - { name: Built In, provider: builtin, enabled: false }                   # United States tech hubs
  - { name: JobStreet, provider: jobstreet, enabled: false }                # Southeast Asia
  - { name: No Fluff Jobs, provider: nofluffjobs, enabled: false }          # Poland and Central Europe
  - { name: Just Join IT, provider: justjoin, enabled: false }              # Poland
  - { name: Welcome to the Jungle, provider: wttj, enabled: false }         # France and Europe
  - { name: Landing.jobs, provider: landingjobs, enabled: false }           # Portugal and Europe
  - { name: The Hub, provider: thehub, enabled: false }                     # Nordic startups
  - { name: Computrabajo, provider: computrabajo, enabled: false }          # Latin America
  - { name: OCC, provider: occ, enabled: false }                            # Mexico
  - { name: ITviec, provider: itviec, enabled: false }                      # Vietnam
# Local employers, e.g. - { name: Example Hospital, careers_url: "https://jobs.example.com/careers" }
watchlist: []
---
# Job sources

Regional boards from the onsite-city preset. Switch on the ones that cover your city; add local employers to the watchlist.
