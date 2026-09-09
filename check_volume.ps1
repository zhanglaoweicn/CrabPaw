Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume volume);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int GetMasterVolumeLevelScalar(out float level);
    int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    int GetMute(out bool mute);
    int SetMute(bool mute, ref Guid ctx);
}
public class AudioUtil {
    [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid rclsid, IntPtr outer, int dwClsContext, ref Guid riid, out IMMDeviceEnumerator ppv);
    public static string CheckAndBoost() {
        Guid CLSID = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
        Guid IID_MMDE = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
        Guid IID_IAEV = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        IMMDeviceEnumerator enumerator;
        CoCreateInstance(ref CLSID, IntPtr.Zero, 1, ref IID_MMDE, out enumerator);
        IMMDevice device;
        enumerator.GetDefaultAudioEndpoint(0, 1, out device);
        IAudioEndpointVolume volume;
        device.Activate(ref IID_IAEV, 1, IntPtr.Zero, out volume);
        float level; bool mute;
        volume.GetMasterVolumeLevelScalar(out level);
        volume.GetMute(out mute);
        Guid empty = Guid.Empty;
        float newLevel = level;
        string ops = "";
        if (mute) { volume.SetMute(false, ref empty); ops += "unmuted;"; }
        if (level < 0.5f) { newLevel = 0.6f; volume.SetMasterVolumeLevelScalar(0.6f, ref empty); ops += "boosted;"; }
        return String.Format("before={0:F0}% mute={1} ops={2} after={3:F0}%", level*100, mute, ops, newLevel*100);
    }
}
'@
[AudioUtil]::CheckAndBoost()
