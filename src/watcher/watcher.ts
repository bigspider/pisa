import { IEthereumAppointment } from "../dataEntities";
import logger from "../logger";
import { EventObserver } from "./eventObserver";
import { ConfigurationError } from "../dataEntities/errors";
import { AppointmentSubscriber } from "./appointmentSubscriber";
import { IAppointmentStore } from "./store";
import { AddAppointmentCommand, ExecutionEngine } from "../undo";

/**
 * Watches the chain for events related to the supplied appointments. When an event is noticed data is forwarded to the
 * supplied event observer to complete the task. The watcher is not responsible for ensuring that observed events are properly
 * acted upon, that is the responsibility of the responder.
 */
export class Watcher {
    /**
     * Watches the chain for events related to the supplied appointments. When an event is noticed data is forwarded to the
     * supplied event observer to complete the task. The watcher is not responsible for ensuring that observed events are properly
     * acted upon, that is the responsibility of the responder.
     */
    public constructor(
        private readonly eventObserver: EventObserver,
        private readonly appointmentSubscriber: AppointmentSubscriber,
        private readonly store: IAppointmentStore,
        private readonly executionEngine: ExecutionEngine

    ) {}

    // there are three separate processes that can run concurrently as part of the watcher
    // each of them updates the data store.
    // 1) NEW APPOINTMENTS:
    //      New appointments are added or updated in the store keyed by appointment.getStateLocator()
    //        i) If an appointment with that locator exists and has a lower nonce, it is updated to be the new appointment
    //        ii) If an appointment with that locator exits and it has a higher or equal nonce, the new appointment is rejected
    //        iii) If it does not exist, it is added
    //      After the appointment has been added to the store it is then and then subscribed to. We subscribe last
    //      because if the event to which the appointment is subscribed is fired then that event will try to remove the
    //      appointment and put the add and remove into a race condition. Therefore we wait until we are certain that the
    //      appointment has been added before it can become possible for it to be removed.
    // 2) OBSERVED EVENTS
    //      When subscribed appointments are observed as events they are first pased to the responder. Then they are
    //      removed from the remote store, and finally from the local store. When appointments are removed they are
    //      keyed by appointment id we are sure to try and remove the exact appointment that the listener was subscribed
    //      against. If the appointment was not in the db, since appointments can be removed in any of these 3 processes:
    //      (new appointments, observed events, GC) then this should not be considered an error
    // 3) GARBAGE COLLECTION (GC)
    //      Periodically appointments will be checked to see if they have expired. To make this process easier we could
    //      order the appointments by expiry date, then pop the top appointment and see if it has expired. If it hasn't
    //      then wait until the next poll. If it has then continue popping appointments until the we reach one that has
    //      not expired. Expired appointment should be removed first from the remote store then the local and unsubsribced,
    //      either singularly or batched, but the order here does not matter. Again deletes should by keyed by
    //      appointment id, and it shouldn't matter if an appointment does not exist to be deleted. (Although this
    //      should be unlikely)

    /**
     * Start watch for an event specified by the appointment, and respond if it the event is raised.
     * @param appointment Contains information about where to watch for events, and what information to suppli as part of a response
     */
    public async addAppointment(appointment: IEthereumAppointment): Promise<boolean> {
        return await this.withLog(appointment, async () => {
            if (!appointment.passedInspection) throw new ConfigurationError(`Inspection not passed.`);

            // update this appointment in the store
            const updated = await this.store.addOrUpdateByStateLocator(appointment);
            if (updated) {
                // current block + hash
                const command: AddAppointmentCommand  = new AddAppointmentCommand(
                    1, "", appointment, this.appointmentSubscriber, this.eventObserver
                )
                this.executionEngine.execute(command);
            }

            return updated;
        });
    }

    /** A helper method just for adding some logging */
    private async withLog(
        appointment: IEthereumAppointment,
        addAppointment: (appointment: IEthereumAppointment) => Promise<boolean>
    ) {
        logger.info(appointment.formatLog(`Begin watching for event ${appointment.getEventName()}.`));

        // business logic
        const result = await addAppointment(appointment);

        if (result) {
            // the new appointment has a lower nonce than the one we're currently storing, so don't add it
            logger.info(appointment.formatLog(`Appointment added to watcher.`));
        } else {
            logger.info(
                appointment.formatLog(
                    `An appointment with a higher nonce than ${appointment.getStateNonce()} already exists. Appointment not added to watcher.`
                )
            );
        }

        return result;
    }
}
