import { IEthereumAppointment } from "../dataEntities";
import { ApplicationError, ArgumentError } from "../dataEntities/errors";
import { EthereumResponderManager } from "../responder";
import { AppointmentStore } from "./store";
import { BlockProcessor, ReadOnlyBlockCache } from "../blockMonitor";
import { Block } from "../dataEntities/block";
import { EventFilter } from "ethers";
import { StandardMappedComponent, StateReducer, MappedStateReducer, MappedState } from "../blockMonitor/component";
import logger from "../logger";

enum AppointmentState {
    WATCHING,
    OBSERVED
}

/** Portion of the anchor state for a single appointment */
type WatcherAppointmentState =
    | {
          state: AppointmentState.WATCHING;
      }
    | {
          state: AppointmentState.OBSERVED;
          blockObserved: number; // block number in which the event was observed
      };

// TODO: move this to a utility function somewhere
const hasLogMatchingEvent = (block: Block, filter: EventFilter): boolean => {
    return block.logs.some(
        log => log.address === filter.address && filter.topics!.every((topic, idx) => log.topics[idx] === topic)
    );
};

class AppointmentStateReducer extends StateReducer<WatcherAppointmentState, Block> {
    constructor(private cache: ReadOnlyBlockCache<Block>, private appointment: IEthereumAppointment) {
        super();
    }
    public getInitialState(block: Block): WatcherAppointmentState {
        const filter = this.appointment.getEventFilter();
        if (!filter.topics) throw new ApplicationError(`topics should not be undefined`);

        const eventAncestor = this.cache.findAncestor(block.hash, ancestor => hasLogMatchingEvent(ancestor, filter));

        if (!eventAncestor) {
            return {
                state: AppointmentState.WATCHING
            };
        } else {
            return {
                state: AppointmentState.OBSERVED,
                blockObserved: eventAncestor.number
            };
        }
    }
    public reduce(prevState: WatcherAppointmentState, block: Block): WatcherAppointmentState {
        if (
            prevState.state === AppointmentState.WATCHING &&
            hasLogMatchingEvent(block, this.appointment.getEventFilter())
        ) {
            return {
                state: AppointmentState.OBSERVED,
                blockObserved: block.number
            };
        } else {
            return prevState;
        }
    }
}

/**
 * Watches the chain for events related to the supplied appointments. When an event is noticed data is forwarded to the
 * observe method to complete the task. The watcher is not responsible for ensuring that observed events are properly
 * acted upon, that is the responsibility of the responder.
 */
export class Watcher extends StandardMappedComponent<WatcherAppointmentState, Block> {
    /**
     * Watches the chain for events related to the supplied appointments. When an event is noticed data is forwarded to the
     * observe method to complete the task. The watcher is not responsible for ensuring that observed events are properly
     * acted upon, that is the responsibility of the responder.
     */
    constructor(
        private readonly responder: EthereumResponderManager,
        blockProcessor: BlockProcessor<Block>,
        private readonly store: AppointmentStore,
        private readonly confirmationsBeforeResponse: number,
        private readonly confirmationsBeforeRemoval: number
    ) {
        super(
            blockProcessor,
            new MappedStateReducer<WatcherAppointmentState, Block, IEthereumAppointment>(
                () => this.store.getAll(),
                (appointment: IEthereumAppointment) =>
                    new AppointmentStateReducer(blockProcessor.blockCache, appointment)
            )
        );

        if (confirmationsBeforeResponse > confirmationsBeforeRemoval) {
            throw new ArgumentError(
                `confirmationsBeforeResponse must be less than or equal to confirmationsBeforeRemoval.`,
                confirmationsBeforeResponse,
                confirmationsBeforeRemoval
            );
        }
    }

    protected getActions() {
        const shouldHaveStartedResponder = (st: WatcherAppointmentState | undefined, block: Block): boolean => {
            if (!st) return false;
            return (
                st.state === AppointmentState.OBSERVED &&
                block!.number - st.blockObserved + 1 >= this.confirmationsBeforeResponse
            );
        };

        const shouldRemoveAppointment = (st: WatcherAppointmentState | undefined, block: Block): boolean => {
            if (!st) return false;
            return (
                st.state === AppointmentState.OBSERVED &&
                block!.number - st.blockObserved + 1 >= this.confirmationsBeforeRemoval
            );
        };

        return [
            {
                condition: shouldHaveStartedResponder,
                action: async (id: string) => {
                    const appointment = this.store.getById(id);
                    // start the responder
                    try {
                        logger.info(
                            appointment.formatLog(
                                `Observed event ${appointment.getEventName()} in contract ${appointment.getContractAddress()}.`
                            )
                        );

                        // TODO: add some logging to replace this
                        // this.logger.debug(appointment.formatLog(`Event info: ${inspect(event)}`));

                        // pass the appointment to the responder to complete. At this point the job has completed as far as
                        // the watcher is concerned, therefore although respond is an async function we do not need to await it for a result
                        await this.responder.respond(appointment);
                    } catch (doh) {
                        // an error occured whilst responding to the callback - this is serious and the problem needs to be correctly diagnosed
                        logger.error(
                            appointment.formatLog(
                                `An unexpected error occured whilst responding to event ${appointment.getEventName()} in contract ${appointment.getContractAddress()}.`
                            )
                        );
                        logger.error(appointment.formatLog(doh));
                    }
                }
            },
            {
                condition: shouldRemoveAppointment,
                action: async (id: string) => {
                    await this.store.removeById(id);
                }
            }
        ];
    }
}
