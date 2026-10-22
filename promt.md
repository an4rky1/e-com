Context & Goal:
We need to implement a comprehensive, production-ready Authentication and Authorization system structured as a set of microservices within our existing NX monorepo. Reference existing project abstractions and modules located at: /home/anarky/second_brain/03-Resources/References/Integrations. If any initial modules or abstractions are substandard, refactor and enhance them to meet clean architecture standards.

1. Architecture & Design Patterns:

- Clean Architecture (strictly separate domain, application, infrastructure, and presentation layers for each microservice).
- DDD & CQRS: Utilize our existing project abstractions for Domain-Driven Design and CQRS.
- Events: Distinguish clearly between Domain Events (internal to the aggregate/service) and Global Events (published across the system).
- Reliability: Implement the Transactional Outbox Pattern for publishing events to Kafka reliably.

1. Microservices Scope (~9 Modules):
   Design and scaffold approximately 9 microservices, with a primary focus on:

- Identity Core Module (user management, credentials, authentication state)
- Access Control Module (RBAC/ABAC permissions, roles, policies)
- Notification Module (queue-driven, triggered asynchronously via Kafka outbox events)
- [List or let the AI outline the remaining related authentication/session/audit microservices if needed]

1. Communication & Integration:

- API Gateway: Act as the single entry point for all client requests.
- Inter-service Sync: Use gRPC for high-performance synchronous communication.
- Event-Driven Async: Use Apache Kafka for asynchronous event propagation and inter-service messaging.

1. NX Workspace & Code Organization:

- Use NX generators to scaffold new apps/libraries where applicable.
- Maintain a clean, logical folder structure per microservice (clearly separating strategies, domain models, handlers, controllers, tests, etc.).
- Ensure proper configuration for dependency injection, shared libraries, and build targets.

1. Testing & Quality:

- Write comprehensive tests for every module (Unit tests for domain logic, Integration tests for handlers/repositories, and E2E tests where appropriate).
- Ensure all modules pass linting, type-checking, and test suites.
