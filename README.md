# Agent Portal for a CRM-based referral programme

A zero-cost partner portal for a visa services company: every referral agent gets a personal link where they see the status of the clients they brought and can submit new ones. Built on Google Apps Script on top of the Kommo CRM API.

**Live demo (sample data):** https://solovyovajenia-gif.github.io/demo_agentportal/

## The problem

The company was launching a referral programme: agents bring clients and receive a commission. Agents needed to see where each of their clients stands, and the company needed to receive new leads from agents without manual back-and-forth.

Contractors proposed two options, both paid: a Telegram bot (hosting plus maintenance, and part of the agents use WhatsApp), or a separate CRM user account per agent (a licence for each seat, and agents would see too much of the CRM).

## The solution

A personal link per agent instead of a bot or CRM seats.

- **Agent = company in the CRM.** No new entities. A lead belongs to an agent when its Company field points to that agent and Source = Agent.
- **Agent page.** Five blocks: New, In progress, Client paid, Commission paid, Client declined. Data is read live from the CRM.
- **Add lead form.** The agent submits a client; it lands in the CRM's Incoming leads with Source, Company, contact details, product, country and the agent's note already filled in. The manager only presses Accept.
- **Admin page.** List of agents with ready links (Copy), and a Deactivate switch for an agent who leaves. Deals stay in the CRM.
- **Security.** Each link carries the company ID and an HMAC signature from a secret; changing the secret revokes all links. Form limits: 30 leads per hour per agent, duplicate guard, honeypot.
- **Cost of ownership: zero.** Apps Script, the existing CRM plan, a one-file redirect on the company domain for a short link.

Onboarding a new agent takes about a minute. First working version: four days from the brief.

## Roles

Business analysis, requirements, data model, process rules, manager guides and testing on the live CRM: Evgeniya Solovyova. Code written by an AI assistant from her specifications.

## Files

- `index.html` – static demo of the agent page with sample data (the Add lead form works locally).
- `Code.gs` – the Apps Script source, anonymised. Script properties required: `KOMMO_TOKEN`, `SECRET`, optional `PORTAL_URL`.
