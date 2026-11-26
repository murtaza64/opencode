/** Whether this page is hidden (another tab, minimized window). Background polls skip their tick while it is: the
 * event hubs pause too, and every subscriber resyncs when the page shows again (DD #922). */
export const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden"
