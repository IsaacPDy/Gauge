# Product Requirements Document
# Limit Gauge — Unified Cloud Usage & Cost Monitoring
**Working name:** Limit Gauge (placeholder; subject to trademark and naming review)  
**Version:** 1.0  
**Date:** October 8, 2026  
**Status:** Initial Product Specification  
**Product type:** Multi-tenant SaaS web application  
**Target audience:** Independent developers, freelancers, small development teams, and startup founders

---

## 1. Executive Summary

Limit Gauge is a unified cloud usage monitoring platform that allows developers to connect their cloud service accounts, discover their projects, track resource consumption, monitor free-tier and paid-plan allowances, and receive notifications before they are projected to exceed those allowances or incur unexpected expenses.

Developers frequently use multiple cloud providers across several applications. Monitoring consumption requires visiting each provider's dashboard, understanding different pricing structures, and manually tracking usage.

Limit Gauge consolidates supported information into one dashboard.

### Core Value Proposition

**Know what your applications consume, understand when they may exceed their limits, and receive early warnings before unexpected costs or service restrictions occur.**

The application does not guarantee prevention of cloud charges. It provides monitoring, forecasts, warnings, and provider-specific cost-control guidance.

---

## 2. Problem Statement

### Current Problems

1. **Fragmented monitoring:** Developers must independently monitor Supabase, Firebase, Cloudflare, AWS, and other cloud services.

2. **Unclear consumption:** Each provider uses different resource metrics, allowances, and pricing rules.

3. **Unexpected charges:** Usage spikes, application bugs, or growing traffic can cause spending beyond expected allowances.

4. **Poor visibility across applications:** Developers lack a single place to understand which application consumes which resources.

5. **Delayed intervention:** Developers may discover excessive usage only after receiving provider alerts or billing statements.

6. **Manual tracking:** Developers must repeatedly inspect provider dashboards to determine whether their resources are approaching their limits.

### Opportunity

Create a developer-focused system that automatically discovers supported resources, collects consumption data, monitors quotas, forecasts overages, and sends useful alerts.

---

## 3. Product Goals

### Primary Goals

- Provide one dashboard for monitoring multiple cloud providers.
- Discover accessible cloud accounts, organizations, and projects automatically.
- Track resource consumption against available quotas and user-configured limits.
- Distinguish free-tier exhaustion, service restrictions, and potential monetary overages.
- Estimate future consumption using historical data.
- Send configurable notifications when warning conditions are met.
- Minimize repeated manual checks of cloud dashboards.

### Secondary Goals

- Present historical usage trends.
- Identify unusual consumption patterns.
- Help users understand which applications contribute to aggregate consumption.
- Recommend appropriate actions for reducing costs.
- Support additional providers through modular integrations.

### Non-Goals for MVP

- Automatically shutting down cloud services.
- Guaranteeing that users will never incur charges.
- Managing or deploying cloud infrastructure.
- Modifying provider subscription plans.
- Processing cloud provider payments.
- Replacing official billing statements.
- Supporting every provider and resource type from launch.
- Using AI to implement basic forecasting.

---

## 4. Target Users

### Primary Persona: Independent Developer

Maintains several personal projects using free-tier and pay-as-you-go services.

**Needs:** Monitor all projects without repeatedly checking each provider dashboard.

### Secondary Persona: Freelancer

Maintains applications for several customers.

**Needs:** Understand resource consumption and separate projects across clients.

### Future Persona: Development Team

Operates multiple production applications across different providers.

**Needs:** Shared monitoring, cost visibility, and coordinated alerts.

---

## 5. Product Structure

The application uses the following organizational hierarchy:

**Workspace**
- Represents an individual user's or team's Limit Gauge environment.
- Contains all connected cloud providers, monitored resources, applications, and notification settings.

**Provider Connection**
- An authorized integration with Supabase, Firebase/Google Cloud, Cloudflare, AWS, or another provider.
- A workspace can have multiple connections to the same provider.

**Provider Account**
- A provider-defined organization, billing account, subscription, or equivalent entity.
- May contain multiple provider projects and resources.
- Often determines billing ownership and quota scope.

**Application**
- A user-defined logical grouping representing a software project.
- An application can contain resources from multiple cloud providers.

**Monitored Resource**
- An actual provider-managed resource, such as a Supabase project, Cloudflare Worker, or Google Cloud project.
- Can be assigned to a logical application.

**Metric**
- A measurable resource consumption value, such as database storage, bandwidth, requests, or compute usage.

**Quota / Budget**
- A provider-reported or user-defined threshold used to evaluate consumption.

**Alert**
- A warning generated when consumption or forecast conditions meet a configured rule.

### Important Distinction

An application and a provider project are not necessarily the same entity.

Limit Gauge must preserve the provider's actual resource hierarchy separately from the user's logical application grouping.

For example, a single application may use Supabase for its database and Cloudflare for hosting.

---

## 6. Core Features

### FR-01: Authentication and Workspace Management

**Priority: P0**

Users must be able to:

- Register an account.
- Log in and log out.
- Recover account access.
- Create a default workspace automatically.
- View and update their workspace details.
- Delete their account and associated monitoring configuration.
- Manage connected provider accounts.

Each workspace must have isolated data.

The underlying architecture must support multiple independent users and workspaces.

**MVP restriction:** One owner per workspace. Inviting team members is deferred.

**Acceptance Criteria**
- A registered user can create and access their workspace.
- Unauthenticated users cannot access workspace data.
- Users cannot read or modify resources belonging to another workspace.

### FR-02: Cloud Provider Connections

**Priority: P0**

Users must be able to connect supported provider accounts using authorized integration methods.

Initial integration:

**Supabase**

Later integrations:

- Cloudflare
- Firebase / Google Cloud
- AWS

Connection methods depend on the provider and may include OAuth, scoped API tokens, or restricted cloud IAM roles.

Users must be able to:

- Connect a provider account.
- View connection status.
- View granted permissions and supported monitoring capabilities.
- Refresh or reauthorize a connection.
- Disconnect a provider.
- Connect multiple accounts from the same provider.

Connection statuses:

- Connected
- Syncing
- Reauthorization required
- Permission insufficient
- Unsupported capability
- Connection error
- Disconnected

**Security Requirement:** Provider access must be limited to the minimum permissions necessary for monitoring. Avoid requesting database passwords, service-role keys, root credentials, or unrestricted administrative permissions.

**Acceptance Criteria**
- A user can connect an authorized account.
- Credentials are securely stored and never exposed to the frontend.
- A successful connection initiates resource discovery.
- A failed connection displays a useful error.
- Disconnecting prevents future synchronization.

### FR-03: Automatic Project and Resource Discovery

**Priority: P0**

After connecting an account, the application should discover the resources that the user is authorized to view and that the provider API supports.

Example:

Supabase connection:
- Accessible organizations
- Projects belonging to those organizations
- Supported usage and configuration metadata

The system should periodically synchronize the resource inventory.

Each discovered resource includes, when available:

- Provider
- Resource name
- Provider resource ID
- Parent account or organization
- Resource type
- Relevant plan information
- Current resource status
- Last synchronization time

Users must be able to:

- View all discovered resources.
- Search and filter resources.
- Choose which resources to monitor.
- Group resources under a logical application.
- Reassign resources between applications.
- Manually initiate resource discovery.

**Important:** Limit Gauge must not claim to automatically discover dependencies between providers unless those relationships can be reliably established.

**Acceptance Criteria**
- Resource discovery imports available provider resources.
- Repeated synchronization does not create duplicates.
- Deleted or inaccessible resources are marked accordingly.
- Previously saved application groupings are preserved.

### FR-04: Quota and Allowance Management

**Priority: P0**

The platform must track quota definitions separately from resource usage.

Example metrics include:

| Provider | Example metrics |
|---|---|
| Supabase | Database size, egress, storage, function invocations, monthly active users |
| Firebase | Firestore operations, stored data, network usage, eligible service costs |
| Cloudflare | Workers requests, R2 usage, D1 usage, billable consumption |
| AWS | Usage quantities, service spending, account budget consumption |

The exact availability of each metric depends on the selected integration and granted permissions.

For every quota, store:

- Provider and metric identifier
- Quota scope: account, organization, project, service, or resource
- Allowance quantity
- Measurement unit
- Billing or quota reset period
- Whether the threshold is provider-reported or user-configured
- Applicable pricing-rule version
- Last verification date
- Whether exceeding the quota can cause charges, restrictions, or both

Quota sources:

1. **Provider-reported quota:** Obtained from an official provider interface.
2. **Configured quota:** Entered or confirmed by the user.
3. **Unknown quota:** No reliable allowance data is available.

The app must never silently replace an unknown quota with an assumed value.

For quotas that cannot be obtained programmatically, users can manually configure and maintain limits.

**Acceptance Criteria**
- Users can view supported quota definitions.
- Users can configure custom limits.
- Organization-level quotas are not incorrectly treated as project-specific allowances.
- Unknown limits are clearly identified.

### FR-05: Usage Collection and Analytics

**Priority: P0**

The application must collect supported usage metrics at scheduled intervals.

Each metric snapshot includes:

- Provider
- Provider account
- Resource or billing scope
- Metric identifier
- Usage quantity
- Measurement unit
- Measurement interval
- Provider data timestamp
- Collection timestamp
- Source
- Data quality or freshness state

The system must support:

- Billing-cycle consumption
- Historical resource consumption
- Percentage of applicable quota used
- Remaining allowance
- Usage trends
- Latest successful synchronization
- Usage breakdown by supported provider dimensions

**Visualization requirements**

- Usage progress bars
- Historical line charts
- Metric summary cards
- Quota thresholds
- Risk indicators

The platform must distinguish cumulative usage counters, incremental usage records, and instantaneous measurements to prevent incorrect calculations.

**Acceptance Criteria**
- Users can inspect consumption for a monitored metric.
- Historical metrics are displayed in appropriate units.
- Repeated fetches do not double-count usage.
- Stale or unavailable metrics are marked as such.

### FR-06: Unified Dashboard

**Priority: P0**

The Home dashboard should provide an overview of the workspace.

**Summary section**
- Total applications
- Connected providers
- Monitored resources
- Active warnings
- Available spending estimate, where supported

**Risk section**
- Metrics approaching limits
- Projected quota exhaustion
- Potential spending overages
- Stale or failed monitoring connections

**Application section**
- Application name
- Connected provider resources
- Monitoring health
- Highest risk level
- Latest detected warning

**Usage section**
- Overall trends
- Selected resource consumption
- Provider usage breakdown

No unified monetary total should be shown if costs cannot be reliably calculated or converted to one currency.

**Acceptance Criteria**
- Dashboard data comes from collected snapshots, not provider API calls on every page load.
- A user can navigate from a warning to the affected resource.
- Unknown cost information is not displayed as zero.

### FR-07: Application Detail Page

**Priority: P0**

Each application has a dedicated detail page.

The page includes:

- Application name and description
- Associated provider resources
- Resource-level usage summaries
- Quota progress
- Active warnings
- Historical consumption
- Relevant monitoring status

Users must be able to:

- Add or remove associated resources.
- Filter metrics.
- Open detailed usage history.
- Navigate to the provider's official dashboard.

Where costs are billed at an account or organization level, the page must not attribute shared charges to the application without a supported allocation method.

### FR-08: Alert System

**Priority: P0**

Users must receive warnings when monitored metrics exceed configured thresholds or are projected to exceed their allowances.

**Alert categories**

1. Quota threshold alert
2. Forecasted limit breach
3. Projected cost overage
4. Monitoring or integration failure

Anomaly detection is planned for the next release.

**Default quota thresholds**

- 50% — Informational
- 75% — Warning
- 90% — Critical
- 100% — Limit reached

Thresholds must be customizable.

**Alert contents**

- Affected application
- Provider
- Billing or resource scope
- Metric name
- Current consumption
- Applicable limit
- Percentage used
- Billing-cycle reset date, if known
- Forecasted breach date, if available
- Recommended next action
- Last data update time

**Notification channels for MVP**

- In-app notifications
- Email

Future:
- Discord
- Slack
- Push notifications
- Webhooks

**Alert delivery behavior**

- Avoid duplicate messages for the same threshold in the same billing cycle.
- Allow alerts to escalate when severity increases.
- Preserve an alert history.
- Allow users to acknowledge or mute warnings.
- Respect user notification preferences.
- Record notification delivery attempts and failures.

**Acceptance Criteria**
- Threshold evaluation occurs after new data is ingested.
- Eligible alerts are queued for delivery.
- Notification failures can be retried without duplicate alerts.
- Users can modify thresholds and notification settings.

### FR-09: Consumption Forecasting

**Priority: P1**

The forecasting engine estimates whether consumption will exceed a quota before the billing cycle ends.

Required inputs:

- Valid historical consumption
- Metric aggregation semantics
- Billing-cycle boundaries
- Applicable quota
- Current usage
- Remaining time in the period

**Initial forecasting method**

For a cumulative billing-cycle metric:

`Projected final usage = current usage + (recent average daily usage × remaining days)`

Use a defined recent observation window, initially up to seven valid daily observations.

A forecast must not be generated unless sufficient valid measurements exist.

The app should display:

- Projected billing-cycle consumption
- Expected quota utilization
- Estimated threshold crossing date
- Forecast confidence or insufficient-data state
- Last observation date

The product may initially use deterministic statistical calculations rather than AI.

**Acceptance Criteria**
- Forecasts are reproducible from stored usage history.
- Reset boundaries are respected.
- Missing or stale data does not produce misleading high-confidence forecasts.
- Forecasts are labeled estimates rather than guaranteed outcomes.

### FR-10: Spending Estimates

**Priority: P1**

Where sufficient official billing and pricing information exists, the platform should display:

- Reported current spending
- Estimated future spending
- Estimated overage charges
- Configured budget consumption
- Billing currency

Cost calculations must account for applicable:

- Included allowances
- Pricing tiers
- Billing cycles
- Provider-reported credits, when available
- Fixed versus usage-based charges
- Pricing rule versions

Do not combine values in different currencies without a defined conversion process.

Do not assume that exceeding a free-tier quota always creates a monetary charge.

Possible outcomes include:

- Additional billable usage
- Service restrictions
- Rate limiting
- Service suspension
- An upgrade requirement

**Acceptance Criteria**
- Actual provider-reported costs are distinguished from calculations.
- Every estimated cost includes its source and calculation status.
- Unsupported pricing models display an unavailable state.

### FR-11: Connection Health Monitoring

**Priority: P0**

The system must monitor the monitoring integrations themselves.

Detect:

- Expired credentials
- Revoked authorization
- Insufficient permissions
- Provider API failures
- Rate-limit responses
- Stale usage data
- Unsuccessful scheduled jobs

Failures must not be interpreted as zero usage.

The app must notify users when monitoring becomes unreliable.

---

## 7. Application Pages

| Page | Primary purpose |
|---|---|
| Home | Cross-provider overview, risk summary, urgent warnings |
| Applications | Manage logical applications and view their resources |
| Application Detail | Inspect all cloud resources associated with one application |
| Providers | Connect accounts, discover resources, inspect connection status |
| Usage Explorer | Analyze supported metrics, history, and quota consumption |
| Alerts | View warning history, acknowledge alerts, manage alert rules |
| Settings | Account, workspace, notifications, and monitoring preferences |

An empty-state onboarding experience should direct new users to connect their first provider.

---

## 8. User Workflows

### Workflow A: First-Time Setup

1. User registers.
2. Default workspace is created.
3. User opens Providers.
4. User selects Supabase.
5. User authorizes access.
6. Limit Gauge validates the connection.
7. Supported organizations and projects are discovered.
8. User selects resources to monitor.
9. User groups resources into logical applications.
10. Available quotas are loaded, or the user configures missing limits.
11. Initial usage collection runs.
12. Dashboard becomes populated.

### Workflow B: Ongoing Monitoring

1. Scheduled worker retrieves available metrics.
2. System validates and normalizes incoming data.
3. Snapshots are stored.
4. Usage against quota is recalculated.
5. Forecasts are updated when sufficient data exists.
6. Alert rules are evaluated.
7. Eligible notifications are delivered.
8. Dashboard reflects the latest successful data.

### Workflow C: Approaching a Limit

1. Resource consumption crosses a configured threshold.
2. Monitoring engine identifies the threshold breach.
3. Alert is created and categorized.
4. Email and in-app notifications are generated.
5. User opens the notification.
6. Application displays current usage, data freshness, and recommended action.
7. User inspects the provider dashboard or adjusts their application.
8. Monitoring continues.

### Workflow D: Failed Integration

1. Provider rejects a scheduled API request.
2. Worker classifies the error.
3. Connection health state changes.
4. System records the failure.
5. User receives a connection warning when appropriate.
6. User reauthorizes or repairs the connection.
7. Monitoring resumes without duplicating historical records.

---

## 9. Provider Integration Strategy

Provider integrations must be modular.

### Supabase — Initial Provider

Target capabilities:
- OAuth-based authorization where suitable.
- Discover accessible organizations and projects.
- Collect supported resource usage metrics.
- Track quota scope and billing periods.
- Support manual quota configuration where reliable billing data is unavailable.

Supabase quotas are often organization-wide, even when usage is generated by individual projects.

The initial release must validate that each selected metric is accessible, correctly scoped, and sufficiently accurate for meaningful alerts.

### Cloudflare — Second Provider

Target capabilities:
- Account discovery.
- Supported billable usage data.
- Usage breakdown by service.
- Historical billable consumption.
- Account-level cost alerts.

Cloudflare's billable usage API has Alpha limitations and updated data may not be real-time.

### Firebase / Google Cloud — Later Provider

Target capabilities:
- Project discovery.
- Cloud Monitoring resource metrics.
- Cloud Billing information.
- Budget-related data.
- Optional billing-export integration.

Some integrations require additional setup or permissions, and billing exports may incur costs.

### AWS — Later Provider

Target capabilities:
- Authorized account discovery.
- Cost Explorer spending data.
- Service-level cost breakdown.
- Budget consumption.
- Available forecasts.

AWS billing retrieval may incur API charges. Collection frequency must account for retrieval costs and data availability.

### Integration Capability Model

Every provider adapter must declare what it supports:

- Account discovery
- Resource discovery
- Resource usage metrics
- Quota retrieval
- Actual cost retrieval
- Forecasting inputs
- Billing-cycle metadata
- Available account-level controls

An integration can support only a subset of these capabilities.

---

## 10. Technical Architecture

### Recommended Initial Stack

**Frontend**
- Next.js
- React
- TypeScript
- Tailwind CSS
- Recharts or an equivalent charting library

**Backend**
- TypeScript API layer
- Provider adapter modules
- Scheduled background workers
- Rule evaluation and forecasting services

**Database**
- PostgreSQL
- Supabase Auth and database are acceptable for the initial implementation
- Row-level security for workspace isolation

**Notifications**
- Transactional email provider
- In-app notifications stored in PostgreSQL

**Deployment**
- Managed frontend hosting
- Managed PostgreSQL
- Reliable scheduled job execution
- Separate worker or job execution environment as needed

### High-Level Data Flow

`Provider APIs → Collection Workers → Normalization → PostgreSQL → Alert/Forecast Engine → Dashboard + Notifications`

### Provider Adapter Requirements

Each adapter should expose consistent operations where supported:

- Validate credentials
- Discover accounts
- Discover resources
- Retrieve supported metrics
- Retrieve applicable quotas
- Retrieve billing data
- Report supported capabilities
- Normalize provider errors

Unsupported operations must return an explicit unsupported result rather than fabricated data.

### Collection Strategy

- Use provider-appropriate polling schedules.
- Prefer cached metrics for dashboard rendering.
- Respect API rate limits.
- Apply exponential backoff for transient failures.
- Avoid unnecessary API calls.
- Maintain collection checkpoints.
- Support idempotent retries.
- Track data freshness and collection errors.

Default collection intervals are implementation settings, not real-time service guarantees. Start with polling measured in hours and tune by provider capability, cost, and rate limits.

---

## 11. Data Model

### Core Tables

| Table | Description |
|---|---|
| users | Authenticated users |
| workspaces | Isolated monitoring environments |
| workspace_members | Workspace membership, expandable for future teams |
| provider_connections | Authorized integrations and connection status |
| provider_accounts | External organizations, billing accounts, or subscriptions |
| provider_resources | Imported provider projects and resources |
| applications | User-defined software applications |
| application_resources | Mapping between applications and provider resources |
| metric_definitions | Supported metric types, units, and aggregation rules |
| quota_rules | Provider or user-defined allowance definitions |
| pricing_rules | Versioned pricing and cost-estimation rules |
| usage_samples | Historical normalized usage measurements |
| cost_records | Reported or calculated spending records |
| alert_rules | Configured warning conditions |
| alerts | Generated alert instances |
| notification_deliveries | Delivery attempts and statuses |
| sync_runs | Collection history, outcomes, and errors |
| audit_logs | Security-relevant actions and changes |

### Important Constraints

- Every workspace-owned record must be securely scoped.
- Provider IDs must remain distinct from internal database IDs.
- Resource discovery must be idempotent.
- Metric units must be explicit.
- Snapshots must preserve source and observation timestamps.
- Provider credentials must be encrypted and inaccessible to client-side code.
- Provider-sourced and user-entered values must remain distinguishable.
- Billing scope must be preserved to prevent duplicate attribution.
- Historical pricing calculations should retain their original rule version.

---

## 12. Security Requirements

### Authentication

Use secure session management with appropriate session expiration.

### Authorization

Enforce workspace-level isolation through server-side authorization and database policies.

### External Credentials

- Encrypt provider tokens at rest.
- Never display complete credentials after creation.
- Exclude secrets from application logs.
- Prefer read-only or narrowly scoped permissions.
- Support credential rotation and revocation.
- Do not store provider database passwords unless a future feature explicitly requires them.

### Operational Security

- Restrict worker access to necessary data.
- Rate-limit authentication and sensitive endpoints.
- Record provider connection changes.
- Handle OAuth state validation and PKCE where applicable.
- Prevent unauthorized cross-workspace resource access.
- Support account and connection deletion.

---

## 13. Non-Functional Requirements

### Reliability

- Scheduled jobs must tolerate transient provider outages.
- Failed collection jobs must not erase prior data.
- Alert delivery should use retry-safe processing.
- Processing must be idempotent.

### Performance

- Dashboard should primarily read normalized stored data.
- Provider integrations should not block normal dashboard navigation.
- Large historical datasets should support pagination and aggregation.

### Scalability

The system must support multiple workspaces, multiple provider accounts per workspace, and many resource records per account.

Workers should be designed so collection jobs can be processed independently.

### Data Transparency

Every displayed metric must clearly distinguish:

- Reported data
- Calculated estimates
- User-defined limits
- Unsupported data
- Stale data

### Accessibility

Use readable visualizations, descriptive labels, keyboard-accessible navigation, and status indicators that do not depend on color alone.

---

## 14. Success Metrics

### Proposed Initial Product KPIs

- **Activation rate:** Percentage of new users who successfully connect at least one provider.
- **Resource discovery success:** Percentage of valid connections that discover expected resources.
- **Monitoring coverage:** Percentage of selected resources with at least one supported, functioning metric.
- **Monitoring freshness:** Percentage of collection jobs completed within their expected schedule.
- **Alert delivery success:** Percentage of eligible notifications successfully delivered.
- **Forecast availability:** Percentage of eligible metrics with sufficient history for a forecast.
- **Weekly engagement:** Percentage of activated users returning to inspect monitoring results.

### Engineering Acceptance Targets

- No confirmed cross-workspace data leakage.
- No unnecessary duplicate alerts for the same threshold and cycle.
- No automatic representation of missing data as zero consumption.
- No cost estimates presented as confirmed billed amounts.
- Alert evaluation completes within 15 minutes after successful ingestion under normal operating conditions.
- Tested recovery from expired tokens, API rate limits, and transient provider errors.

These are proposed development targets rather than observed product performance.

---

## 15. Implementation Plan

### Checkpoint 1 — Application Foundation

Build:
- Authentication
- Workspace creation
- Database schema
- Row-level security
- Main application shell
- Empty-state onboarding

**Deliverable:** Users can register, log in, and access an isolated workspace.

### Checkpoint 2 — Supabase Connection

Build:
- Supabase authorization
- Credential management
- Connection validation
- Organization/project discovery
- Resource persistence
- Connection health states

**Deliverable:** Users can connect Supabase and see accessible projects.

### Checkpoint 3 — Monitoring Infrastructure

Build:
- Provider adapter interface
- Metric definition registry
- Scheduled ingestion
- Historical usage storage
- Unit normalization
- Quota configuration
- Data freshness tracking

**Deliverable:** Supported Supabase metrics appear with consumption history and applicable limits.

### Checkpoint 4 — Monitoring Dashboard

Build:
- Home dashboard
- Application management
- Application detail pages
- Resource-to-application mapping
- Progress indicators
- Historical charts
- Usage explorer

**Deliverable:** Users can monitor their imported resources and organize them by application.

### Checkpoint 5 — Alerts and Notifications

Build:
- Threshold rules
- Rule evaluation
- Alert persistence
- In-app notifications
- Email delivery
- Alert deduplication
- Notification settings

**Deliverable:** Users receive warnings when configured thresholds are breached.

### Checkpoint 6 — Forecasting and Cost Estimates

Build:
- Consumption projection logic
- Estimated threshold crossing dates
- Forecast quality checks
- Supported cost calculations
- Projected-risk alerts

**Deliverable:** Users can see when supported resources are likely to exceed allowances or budgets.

### Checkpoint 7 — Cloudflare Integration

Build:
- Cloudflare authorization
- Supported account discovery
- Billable usage ingestion
- Account-level reporting
- Cost and quota integration
- Cross-provider dashboard support

**Deliverable:** Users can monitor Supabase and Cloudflare in the same workspace.

### Checkpoint 8 — Public Launch Readiness

Build and validate:
- Production monitoring
- Failure recovery
- Security review
- Rate-limit handling
- End-to-end integration tests
- User onboarding documentation
- Credential deletion and connection revocation
- Usage-data retention policies
- Privacy policy and terms of service
- Clear billing-estimate disclaimers

**Deliverable:** Public beta suitable for onboarding initial users.

---

## 16. Future Features

### Phase 2
- Firebase / Google Cloud integration
- AWS integration
- Discord and Slack notifications
- Anomaly detection
- Custom budgets per provider or logical application
- CSV export
- Weekly usage reports

### Phase 3
- Team workspaces and roles
- Client-based reporting
- Advanced forecasting
- Cost attribution rules
- Resource optimization suggestions
- More cloud providers
- Public API and webhooks

### Phase 4
- Optional AI-generated explanations of unusual usage
- Automated remediation recommendations
- Provider-supported cost controls, subject to explicit permissions and safety review

Automated shutdown or throttling must never be added without clear safeguards and user authorization.

---

## 17. Product Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Provider billing data arrives late | Display timestamps and data freshness; never promise instant protection |
| Provider APIs expose incomplete metrics | Capability-based integration design and clear unsupported states |
| Provider pricing changes | Versioned pricing rules and verification dates |
| Organization-level quotas cause incorrect project totals | Preserve provider billing scope and avoid double-counting |
| API requests themselves generate charges | Cache results and implement provider-specific polling policies |
| Credentials expire or are revoked | Connection health monitoring and reauthorization workflows |
| Forecasts are misleading after traffic spikes | Mark estimation uncertainty and require sufficient observations |
| Users mistake alerts for spending caps | Explicitly distinguish monitoring alerts from enforced provider controls |

---

## 18. MVP Definition of Done

The initial release is complete when a user can:

1. Register and access a private workspace.
2. Connect a Supabase account securely.
3. Automatically discover accessible organizations and projects.
4. Select resources to monitor.
5. Group resources into logical applications.
6. View reliably available usage metrics.
7. View applicable provider-reported or configured quotas.
8. Inspect historical usage.
9. Configure warning thresholds.
10. Receive in-app and email notifications.
11. Identify stale or failed monitoring integrations.
12. Disconnect their provider account and revoke stored connection access.

Forecasting, Cloudflare integration, and multi-provider monetary cost aggregation are later checkpoints.

**MVP Product Promise:**

Connect your Supabase projects, see supported resource consumption in one place, and receive notifications as configured limits are approached.

**Long-Term Product Vision:**

A unified, proactive cloud consumption intelligence platform that helps developers monitor their applications, anticipate quota exhaustion, and make informed cost-control decisions across multiple providers.

---

## 19. Reference Documentation

- Supabase Management API: https://supabase.com/docs/reference/api/introduction
- Supabase OAuth Integration: https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration
- Supabase Billing: https://supabase.com/docs/guides/platform/billing-on-supabase
- Supabase Cost Control: https://supabase.com/docs/guides/platform/cost-control
- Cloudflare Billable Usage: https://developers.cloudflare.com/billing/manage/billable-usage/
- Firebase Budget Alerts: https://firebase.google.com/docs/projects/billing/budget-alerts
- Google Cloud Billing Export: https://cloud.google.com/billing/docs/how-to/export-data-bigquery
- AWS Cost Explorer: https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html

**Implementation note:** Provider endpoints, available scopes, pricing, and supported metrics must be verified against current official documentation before implementing each adapter.