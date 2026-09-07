using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;
using System.Drawing;

internal static class Launcher
{
    private const string Url = "http://127.0.0.1:43187/";
    private static Process serverProcess;

    [STAThread]
    private static void Main()
    {
        bool created;
        using (Mutex mutex = new Mutex(true, "Local\\WeaselToolboxPortable", out created))
        {
            if (!created)
            {
                OpenToolbox();
                return;
            }

            string root = AppDomain.CurrentDomain.BaseDirectory;
            string appDir = Path.Combine(root, "app");
            string nodePath = Path.Combine(root, "runtime", "node.exe");
            string serverPath = Path.Combine(appDir, "server.mjs");

            if (!File.Exists(nodePath) || !File.Exists(serverPath))
            {
                MessageBox.Show("便携版文件不完整，请重新解压后再运行。", "小狼毫扩展工具箱", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            if (!IsToolboxReady())
            {
                ProcessStartInfo startInfo = new ProcessStartInfo(nodePath, "\"" + serverPath + "\"");
                startInfo.WorkingDirectory = appDir;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                startInfo.EnvironmentVariables["TOOLBOX_STATIC"] = "1";
                startInfo.EnvironmentVariables["TOOLBOX_PORT"] = "43187";
                serverProcess = Process.Start(startInfo);

                for (int attempt = 0; attempt < 60 && !IsToolboxReady(); attempt++)
                    Thread.Sleep(100);
            }

            if (!IsToolboxReady())
            {
                StopServer();
                MessageBox.Show("工具服务启动失败。请确认 43187 端口未被其他程序占用。", "小狼毫扩展工具箱", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            OpenToolbox();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("打开工具箱", null, delegate { OpenToolbox(); });
            menu.Items.Add("退出", null, delegate { Application.Exit(); });

            using (NotifyIcon tray = new NotifyIcon())
            {
                tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
                tray.Text = "小狼毫扩展工具箱";
                tray.ContextMenuStrip = menu;
                tray.Visible = true;
                tray.DoubleClick += delegate { OpenToolbox(); };
                Application.ApplicationExit += delegate { StopServer(); };
                Application.Run();
                tray.Visible = false;
            }
        }
    }

    private static bool IsToolboxReady()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Url);
            request.Timeout = 500;
            request.Proxy = null;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                return response.StatusCode == HttpStatusCode.OK && reader.ReadToEnd().Contains("小狼毫扩展工具箱");
        }
        catch { return false; }
    }

    private static void OpenToolbox()
    {
        Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
    }

    private static void StopServer()
    {
        try
        {
            if (serverProcess != null && !serverProcess.HasExited)
            {
                serverProcess.Kill();
                serverProcess.WaitForExit(3000);
            }
        }
        catch { }
    }
}
