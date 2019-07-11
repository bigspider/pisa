import { IEthereumAppointment } from "../dataEntities";
import { ApplicationError, ArgumentError } from "../dataEntities/errors";
import { EthereumResponderManager } from "../responder";
import { AppointmentStore } from "./store";
import { ReadOnlyBlockCache } from "../blockMonitor";
import { Block } from "../dataEntities/block";
import { EventFilter } from "ethers";
import { StateReducer, MappedStateReducer, MappedState, Component } from "../blockMonitor/component";
import logger from "../logger";

enum AppointmentState {
    WATCHING,
    OBSERVED
}

/** Portion of the anchor state for a single appointment */
type WatcherAppointmentAnchorState =
    | {
          state: AppointmentState.WATCHING;
      }
    | {
          state: AppointmentState.OBSERVED;
          blockObserved: number; // block number in which the event was observed
      };

/** The complete anchor state for the watcher, that also includes the block number */
interface WatcherAnchorState extends MappedState<WatcherAppointmentAnchorState> {
    blockNumber: number;
}

// TODO:198: move this to a utility function somewhere
const hasLogMatchingEvent = (block: Block, filter: EventFilter): boolean => {
    return block.logs.some(
        log => log.address === filter.address && filter.topics!.every((topic, idx) => log.topics[idx] === topic)
    );
};

class AppointmentStateReducer implements StateReducer<WatcherAppointmentAnchorState, Block> {
    constructor(private cache: ReadOnlyBlockCache<Block>, private appointment: IEthereumAppointment) {}
    public getInitialState(block: Block): WatcherAppointmentAnchorState {
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
    public reduce(prevState: WatcherAppointmentAnchorState, block: Block): WatcherAppointmentAnchorState {
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

export class WatcherStateReducer extends MappedStateReducer<WatcherAppointmentAnchorState, Block, IEthereumAppointment>
    implements StateReducer<WatcherAnchorState, Block> {
    constructor(store: AppointmentStore, blockCache: ReadOnlyBlockCache<Block>) {
        super(
            () => store.getAll(),
            (appointment: IEthereumAppointment) => new AppointmentStateReducer(blockCache, appointment)
        );
    }

    public getInitialState(block: Block): WatcherAnchorState {
        return {
            ...super.getInitialState(block),
            blockNumber: block.number
        };
    }

    public reduce(prevState: WatcherAnchorState, block: Block): WatcherAnchorState {
        return {
            ...super.reduce(prevState, block),
            blockNumber: block.number
        };
    }
}

/**
 * Watches the chain for events related to the supplied appointments. When an event is noticed data is forwarded to the
 * observe method to complete the task. The watcher is not responsible for ensuring that observed events are properly
 * acted upon, that is the responsibility of the responder.
 */
export class Watcher extends Component<WatcherAnchorState, Block> {
    /**
     * Watches the chain for events related to the supplied appointments. When an event is noticed data is forwarded to the
     * observe method to complete the task. The watcher is not responsible for ensuring that observed events are properly
     * acted upon, that is the responsibility of the responder.
     */
    constructor(
        private readonly responder: EthereumResponderManager,
        blockCache: ReadOnlyBlockCache<Block>,
        private readonly store: AppointmentStore,
        private readonly confirmationsBeforeResponse: number,
        private readonly confirmationsBeforeRemoval: number
    ) {
        super(new WatcherStateReducer(store, blockCache));

        if (confirmationsBeforeResponse > confirmationsBeforeRemoval) {
            throw new ArgumentError(
                `confirmationsBeforeResponse must be less than or equal to confirmationsBeforeRemoval.`,
                confirmationsBeforeResponse,
                confirmationsBeforeRemoval
            );
        }
    }

    private shouldHaveStartedResponder = (
        state: WatcherAnchorState,
        appointmentState: WatcherAppointmentAnchorState | undefined
    ): boolean =>
        appointmentState != undefined &&
        appointmentState.state === AppointmentState.OBSERVED &&
        state.blockNumber - appointmentState.blockObserved + 1 >= this.confirmationsBeforeResponse;

    private shouldRemoveAppointment = (
        state: WatcherAnchorState,
        appointmentState: WatcherAppointmentAnchorState | undefined
    ): boolean =>
        appointmentState != undefined &&
        appointmentState.state === AppointmentState.OBSERVED &&
        state.blockNumber - appointmentState.blockObserved + 1 >= this.confirmationsBeforeRemoval;

    public async handleNewStateEvent(prevState: WatcherAnchorState, state: WatcherAnchorState) {
        for (const [objId, appointmentState] of state.items.entries()) {
            const prevAppointmentState = prevState.items.get(objId);

            if (
                !this.shouldHaveStartedResponder(prevState, prevAppointmentState) &&
                this.shouldHaveStartedResponder(state, appointmentState)
            ) {
                const appointment = this.store.getById(objId);
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

            if (
                !this.shouldRemoveAppointment(prevState, prevAppointmentState) &&
                this.shouldRemoveAppointment(state, appointmentState)
            ) {
                await this.store.removeById(objId);
            }
        }
    }
}
