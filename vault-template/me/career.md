---
tags: me
# Your resume as data. Claude proposes sections and facts word for word from your resume; you approve them.
resume: { file_name: "{first_name} {last_name} Resume.pdf", paper: A4, max_pages: 2 }   # paper: A4 | Letter
# Optional: language (the resume's, e.g. de), word (CV | resume), headings ({ experience: … }), personal ([date_of_birth, nationality, languages])
# The language your facts are written in (e.g. en): answers in another language cite a fact through its approved translation.
language: ""
# Page order. kind: summary | experience | list | skills | education
# e.g. - { id: example-gmbh, kind: experience, title: Data Analyst, org: Example GmbH, where: Berlin, dates: "2022 – now", start: 2022-03 }
sections: []
# Every bullet Claude may use, word for word. Ids are <section id>.<slug>, e.g. example-gmbh.dashboards
# A translation you approved word for word goes under tr: { id: …, text: …, tr: { de: "…" } }
facts: []
skills: []
# Names of tools or certifications from your field that answers may only mention when a fact does (beyond the built-in list).
terms: { extra: [] }
---
# Career

Claude never writes a bullet that isn't here.
