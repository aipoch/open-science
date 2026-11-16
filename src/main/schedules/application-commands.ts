import { z } from 'zod'
import {
  defineApplicationCommandContract,
  validationCodec
} from '../../shared/application-command-contract'
import {
  scheduleListSchema,
  scheduleSummarySchema,
  type ScheduleSummary,
  scheduleHistoryRequestSchema,
  scheduleRunSchema,
  type ScheduleHistoryRequest,
  type ScheduleRun,
  scheduleEditSchema,
  scheduleDeleteSchema,
  type ScheduleDeleteRequest,
  scheduleCreateSchema,
  scheduleViewSchema,
  type ScheduleListRequest,
  type ScheduleCreateRequest,
  type ScheduleEditRequest,
  type ScheduleView
} from '../../shared/session-schedules'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandRegistrar,
  type ApplicationCommandInstallation
} from '../application-command-router'

export type ScheduleCommands = {
  history(request: ScheduleHistoryRequest): Promise<ScheduleRun[]>
  summaries(request: ScheduleListRequest): Promise<ScheduleSummary[]>
  get(request: ScheduleHistoryRequest): Promise<ScheduleView | null>
  create(request: ScheduleCreateRequest): Promise<ScheduleView>
  delete(request: ScheduleDeleteRequest): Promise<void>
  edit(request: ScheduleEditRequest): Promise<ScheduleView>
}
export const scheduleCommandGroup = defineApplicationCommandGroup('schedules', [
  defineApplicationCommand<'schedules:history', readonly [ScheduleHistoryRequest], ScheduleRun[]>(
    'schedules:history',
    defineApplicationCommandContract(
      validationCodec(z.tuple([scheduleHistoryRequestSchema])),
      validationCodec(z.array(scheduleRunSchema))
    )
  ),
  defineApplicationCommand<'schedules:list', readonly [ScheduleListRequest], ScheduleSummary[]>(
    'schedules:list',
    defineApplicationCommandContract(
      validationCodec(z.tuple([scheduleListSchema])),
      validationCodec(z.array(scheduleSummarySchema))
    )
  ),
  defineApplicationCommand<'schedules:get', readonly [ScheduleHistoryRequest], ScheduleView | null>(
    'schedules:get',
    defineApplicationCommandContract(
      validationCodec(z.tuple([scheduleHistoryRequestSchema])),
      validationCodec(scheduleViewSchema.nullable())
    )
  ),
  defineApplicationCommand<'schedules:create', readonly [ScheduleCreateRequest], ScheduleView>(
    'schedules:create',
    defineApplicationCommandContract(
      validationCodec(z.tuple([scheduleCreateSchema])),
      validationCodec(scheduleViewSchema)
    )
  ),
  defineApplicationCommand<'schedules:delete', readonly [ScheduleDeleteRequest], void>(
    'schedules:delete',
    defineApplicationCommandContract(
      validationCodec(z.tuple([scheduleDeleteSchema])),
      validationCodec(z.void())
    )
  ),
  defineApplicationCommand<'schedules:edit', readonly [ScheduleEditRequest], ScheduleView>(
    'schedules:edit',
    defineApplicationCommandContract(
      validationCodec(z.tuple([scheduleEditSchema])),
      validationCodec(scheduleViewSchema)
    )
  )
] as const)

export function registerScheduleCommands(
  registrar: ApplicationCommandRegistrar,
  owner: ScheduleCommands
): ApplicationCommandInstallation {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(scheduleCommandGroup, {
      'schedules:history': ({ args }) => owner.history(args[0]),
      'schedules:list': ({ args }) => owner.summaries(args[0]),
      'schedules:get': ({ args }) => owner.get(args[0]),
      'schedules:create': ({ args }) => owner.create(args[0]),
      'schedules:delete': ({ args }) => owner.delete(args[0]),
      'schedules:edit': ({ args }) => owner.edit(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
