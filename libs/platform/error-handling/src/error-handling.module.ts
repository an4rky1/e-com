import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';

/**
 * Registers the RFC 7807 filter globally.
 *
 * @remarks Bound through `APP_FILTER` rather than `useGlobalFilters` in `main.ts`: a
 * provider registered here is instantiated by the container, so it gets injected
 * dependencies and cannot be forgotten by a thin bootstrap.
 */
@Global()
@Module({})
export class ErrorHandlingModule {
  static forRoot(): DynamicModule {
    return {
      module: ErrorHandlingModule,
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
      exports: [],
    };
  }
}